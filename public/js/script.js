// ---------- GLOBAL VARIABLES ----------
const socket = io();
let gameState = {
  tickets: [],
  calledNumbers: [],
  fullHousieWinners: [],
  winners: [],
  status: "NO_ACTIVE_GAME",
  drawSequence: [],
  drawIndex: 0,
  gameCreatedAt: null,
  gameStartedAt: null,
  gameEndedAt: null,
  countdownEndTime: null,
  lastCallTime: null,
  maxWinners: 5,
  currentPrizeRank: 1,
  gameEndReason: null,
};
let isHostAuthenticated = false;
let hostSearchTerm = "";
let playerSearchTerm = "";
let countdownInterval = null;
let waRanges = [];

// Inline form state
let activeBookingTicketId = null;
let activeEditTicketId = null;

// Text-to-Speech
let lastSpokenCountdownSecond = -1;
let currentUtterance = null;

// ---------- INITIALIZATION ----------
// Load saved WhatsApp ranges
function loadWARanges() {
  const saved = localStorage.getItem("waRanges");
  if (saved) {
    try {
      waRanges = JSON.parse(saved);
      // Clean phone numbers
      waRanges = waRanges.map((r) => ({
        ...r,
        number: r.number.replace(/[\s\-\(\)\+]/g, ""),
      }));
    } catch (e) {
      console.error("Error loading ranges:", e);
      waRanges = [{ start: "T-01", end: "T-50", number: "917629048752" }];
    }
  } else {
    waRanges = [{ start: "T-01", end: "T-50", number: "917629048752" }];
  }
}
loadWARanges();

// ---------- SOCKET HANDLERS ----------
socket.on("connect", () => {
  console.log("Socket connected");
  if (localStorage.getItem("hostAuth") === "true") {
    const username = localStorage.getItem("hostUser") || "admin";
    const password = localStorage.getItem("hostPass") || "myNewSecret";
    socket.emit("host:login", { username, password });
  }
});

socket.on("gameState", (newState) => {
  const oldCalledLength = gameState.calledNumbers?.length || 0;
  gameState = { ...gameState, ...newState };

  if (gameState.calledNumbers.length > oldCalledLength) {
    const newNum = gameState.calledNumbers[gameState.calledNumbers.length - 1];
    if (!isHostAuthenticated) {
      showPopupNumber(newNum);
    }
    updateStickyNumber(newNum);
    speak(newNum.toString());
  }

  updateUI();
  handleCountdownTimer();
  toggleWinnersVisibility();
});

socket.on("newFullHousieWinner", (winner) => {
  confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
});

socket.on("host:login:success", () => {
  console.log("Login success");
  isHostAuthenticated = true;
  localStorage.setItem("hostAuth", "true");
  localStorage.setItem("hostUser", document.getElementById("username").value);
  localStorage.setItem("hostPass", document.getElementById("password").value);
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("dashboardSection").style.display = "block";
  document.getElementById("loginError").style.display = "none";
  updateUI();
});

socket.on("host:login:failure", (data) => {
  document.getElementById("loginError").textContent =
    data.message || "Invalid credentials";
  document.getElementById("loginError").style.display = "block";
  localStorage.removeItem("hostAuth");
  localStorage.removeItem("hostUser");
  localStorage.removeItem("hostPass");
});

socket.on("host:error", (data) => {
  alert(data.message || "An error occurred");
});

socket.on("disconnect", () => {
  console.log("Socket disconnected");
});

// ---------- UI UPDATE FUNCTIONS ----------
function updateUI() {
  const hostVisible =
    document.getElementById("hostPanel").style.display !== "none";
  if (hostVisible) {
    renderHost();
  } else {
    renderPlayer();
  }
  updateStatusBadges();
  updateBackButton();
}

function renderHost() {
  const total = gameState.tickets.length;
  const booked = gameState.tickets.filter((t) => t.isBooked).length;
  const available = total - booked;
  const prizeRanksAwarded = new Set(
    gameState.fullHousieWinners.map((w) => w.order),
  ).size;

  document.getElementById("totalTickets").textContent = total;
  document.getElementById("bookedTickets").textContent = booked;
  document.getElementById("availableTickets").textContent = available;
  document.getElementById("winnersCount").textContent =
    `${prizeRanksAwarded}/${gameState.maxWinners}`;

  // Show/hide search input
  const searchInput = document.getElementById("hostSearchInput");
  searchInput.style.display = available === 0 ? "none" : "block";

  renderCalledNumbers("host");
  renderWinners("host");
  renderTickets("host");
  renderWARanges();

  // Create game section visibility
  document.getElementById("createGameSection").style.display =
    gameState.status === "NO_ACTIVE_GAME" ? "block" : "none";

  // Game control panel
  const gameControlPanel = document.getElementById("gameControlPanel");
  if (gameState.status !== "NO_ACTIVE_GAME") {
    gameControlPanel.style.display = "block";
    document.getElementById("sequenceInputContainer").style.display =
      gameState.status === "BOOKING_OPEN" ? "block" : "none";
  } else {
    gameControlPanel.style.display = "none";
  }

  // Countdown card
  const countdownCard = document.getElementById("hostCountdownCard");
  if (gameState.status === "COUNTDOWN" && gameState.countdownEndTime) {
    countdownCard.classList.add("show");
  } else {
    countdownCard.classList.remove("show");
  }

  // Sticky number
  const sticky = document.getElementById("hostCurrentNumberSticky");
  if (gameState.status === "RUNNING" && gameState.calledNumbers.length > 0) {
    sticky.style.display = "block";
    document.getElementById("hostCurrentNumberValue").textContent =
      gameState.calledNumbers[gameState.calledNumbers.length - 1];
  } else {
    sticky.style.display = "none";
  }
}

function renderPlayer() {
  const total = gameState.tickets.length;
  const booked = gameState.tickets.filter((t) => t.isBooked).length;
  const available = total - booked;
  const called = gameState.calledNumbers.length;
  const prizeRanksAwarded = new Set(
    gameState.fullHousieWinners.map((w) => w.order),
  ).size;

  const availElem = document.getElementById("playerAvailableTickets");
  const calledElem = document.getElementById("playerCalledCount");
  const calledDisplayElem = document.getElementById("playerCalledCountDisplay");
  const winnersElem = document.getElementById("playerWinnersCount");

  if (availElem) availElem.textContent = available;
  if (calledElem) calledElem.textContent = `${called}/90`;
  if (calledDisplayElem) calledDisplayElem.textContent = `${called}/90`;
  if (winnersElem)
    winnersElem.textContent = `${prizeRanksAwarded}/${gameState.maxWinners}`;

  // Called numbers grid visibility
  const calledWrapper = document.querySelector("#playerPanel .called-wrapper");
  if (calledWrapper) {
    calledWrapper.style.display =
      gameState.status === "COUNTDOWN" ||
      gameState.status === "RUNNING" ||
      gameState.status === "COMPLETED"
        ? "block"
        : "none";
  }

  renderCalledNumbers("player");
  renderWinners("player");

  // Countdown card
  const countdownCard = document.getElementById("playerCountdownCard");
  if (gameState.status === "COUNTDOWN" && gameState.countdownEndTime) {
    countdownCard.classList.add("show");
  } else {
    countdownCard.classList.remove("show");
  }

  // Sticky number
  const sticky = document.getElementById("playerCurrentNumberSticky");
  const stickyValue = document.getElementById("playerCurrentNumberValue");
  if (gameState.status === "RUNNING" && gameState.calledNumbers.length > 0) {
    sticky.style.display = "block";
    stickyValue.textContent =
      gameState.calledNumbers[gameState.calledNumbers.length - 1];
  } else {
    sticky.style.display = "none";
  }

  renderTickets("player");
}

function renderCalledNumbers(view) {
  const gridId =
    view === "host" ? "calledNumbersGrid" : "playerCalledNumbersGrid";
  const grid = document.getElementById(gridId);
  if (!grid) return;
  let html = "";
  for (let i = 1; i <= 90; i++) {
    const called = gameState.calledNumbers.includes(i) ? "called" : "";
    html += `<div class="number-cell ${called}">${i}</div>`;
  }
  grid.innerHTML = html;
  const countId = view === "host" ? "calledCount" : "playerCalledCountDisplay";
  document.getElementById(countId).textContent =
    `${gameState.calledNumbers.length}/90`;
}

function renderWinners(view) {
  const listId = view === "host" ? "hostWinnersList" : "playerWinnersList";
  const sectionId =
    view === "host" ? "hostWinnersSection" : "playerWinnersSection";
  const progressId =
    view === "host" ? "hostWinnersProgress" : "playerWinnersProgress";
  const list = document.getElementById(listId);
  const section = document.getElementById(sectionId);
  const progress = document.getElementById(progressId);
  if (!list || !section || !progress) return;

  const winners = gameState.fullHousieWinners || [];
  const prizeRanksAwarded = new Set(winners.map((w) => w.order)).size;

  if (prizeRanksAwarded === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "block";
  progress.style.width = `${(prizeRanksAwarded / gameState.maxWinners) * 100}%`;

  let html = "";
  winners
    .sort((a, b) => a.order - b.order)
    .forEach((w) => {
      let medal = "🏅";
      let cardClass = "winner-card";
      if (w.order === 1) {
        medal = "🥇";
        cardClass += " first";
      } else if (w.order === 2) {
        medal = "🥈";
        cardClass += " second";
      } else if (w.order === 3) {
        medal = "🥉";
        cardClass += " third";
      }
      html += `
      <div class="${cardClass}">
        <div class="winner-medal">${medal}</div>
        <div class="winner-details">
          <div class="winner-order">#${w.order}</div>
          <div class="winner-name">${w.playerName || "Unknown"}</div>
          <div class="winner-ticket">${w.ticketId}</div>
          <div class="winner-time">${w.winTime || ""}</div>
        </div>
        <div class="winner-actions">
          <button class="view-btn" onclick="showWinnerModal('${w.ticketId}')">👁️ View</button>
        </div>
      </div>
    `;
    });
  list.innerHTML = html;
}

function renderTickets(view) {
  const isHost = view === "host";
  const gridId = isHost ? "ticketsGrid" : "playerTicketsGrid";
  const noResultsId = isHost ? null : "playerNoResults";
  const grid = document.getElementById(gridId);
  const noResults = noResultsId ? document.getElementById(noResultsId) : null;
  if (!grid) return;

  const searchTerm = isHost ? hostSearchTerm : playerSearchTerm;
  let filtered = gameState.tickets;

  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = gameState.tickets.filter(
      (t) =>
        t.id.toLowerCase().includes(term) ||
        (t.bookedBy && t.bookedBy.toLowerCase().includes(term)),
    );
  } else {
    if (!isHost && gameState.status === "BOOKING_OPEN") {
      filtered = gameState.tickets.filter(
        (t) => !t.isBooked && !t.isFullHousieWinner,
      );
    } else if (!isHost) {
      filtered = [];
    }
  }

  if (filtered.length === 0) {
    if (noResults) {
      grid.style.display = "none";
      noResults.style.display = "block";
      noResults.textContent = searchTerm
        ? "No tickets match your search"
        : "Search for a ticket to view";
    } else {
      grid.innerHTML = '<div class="no-results">No tickets</div>';
    }
    return;
  }

  if (noResults) noResults.style.display = "none";
  grid.style.display = "flex";

  let html = "";
  filtered.forEach((t) => {
    if (isHost) {
      // Host compact view
      let cardClass = "ticket-card host-compact";
      let statusText = "";
      let statusClass = "";

      if (t.isFullHousieWinner) {
        cardClass += " winner";
        statusText = `🏆 WINNER #${t.fullHousieOrder}`;
        statusClass = "status-winner";
      } else if (t.isBooked) {
        cardClass += " booked";
        statusText = `📌 ${t.bookedBy}`;
        statusClass = "status-booked";
      } else {
        cardClass += " available";
        statusText = "⚡ Available";
        statusClass = "status-available";
      }

      html += `<div class="${cardClass}" id="ticket-${t.id}">`;
      html += `<div class="ticket-header">`;
      html += `<span class="ticket-id">${t.id}</span>`;
      html += `<span class="ticket-status ${statusClass}">${statusText}</span>`;
      html += `</div>`;

      // Inline booking form?
      if (activeBookingTicketId === t.id) {
        html += `
          <div class="inline-form">
            <input type="text" id="inline-name-${t.id}" class="search-input" placeholder="Player name" autofocus>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <button class="btn btn-success" onclick="confirmInlineBooking('${t.id}')">✅ Confirm</button>
              <button class="btn btn-danger" onclick="cancelInlineBooking()">❌ Cancel</button>
            </div>
          </div>
        `;
      }
      // Inline edit form?
      else if (activeEditTicketId === t.id) {
        html += `
          <div class="inline-form">
            <input type="text" id="inline-edit-${t.id}" class="search-input" value="${t.bookedBy || ""}" placeholder="New player name" autofocus>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <button class="btn btn-success" onclick="confirmInlineEdit('${t.id}')">💾 Save</button>
              <button class="btn btn-danger" onclick="cancelInlineEdit()">❌ Cancel</button>
            </div>
          </div>
        `;
      }
      // Normal action buttons
      else if (gameState.status === "BOOKING_OPEN" && !t.isFullHousieWinner) {
        if (!t.isBooked) {
          html += `<button class="btn btn-secondary" onclick="openInlineBooking('${t.id}')">📌 Book</button>`;
        } else {
          html += `<div style="display:flex; gap:8px; margin-top:12px;">`;
          html += `<button class="btn btn-primary" onclick="openInlineEdit('${t.id}', '${t.bookedBy}')">✏️ Edit</button>`;
          html += `<button class="btn btn-danger" onclick="unbookTicket('${t.id}')">🗑️ Unbook</button>`;
          html += `</div>`;
        }
      }

      html += `</div>`;
    } else {
      // Player full view
      let cardClass = "ticket-card";
      let statusClass = "status-available";
      let statusText = "⚡ Available";

      if (t.isFullHousieWinner) {
        cardClass += " winner";
        statusClass = "status-winner";
        statusText = `🏆 WINNER #${t.fullHousieOrder}`;
      } else if (t.isBooked) {
        cardClass += " booked";
        statusClass = "status-booked";
        statusText = `📌 ${t.bookedBy || "Booked"}`;
      }

      html += `<div class="${cardClass}">`;
      html += `<div class="ticket-header"><span class="ticket-id">${t.id}</span>`;
      html += `<span class="ticket-status ${statusClass}">${statusText}</span></div>`;
      html += `<div class="ticket-numbers">`;

      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 9; c++) {
          const num = t.numbers[r][c];
          if (num === 0) {
            html += `<div class="ticket-num empty"></div>`;
          } else {
            const marked = gameState.calledNumbers.includes(num)
              ? "marked"
              : "";
            html += `<div class="ticket-num ${marked}">${num}</div>`;
          }
        }
      }

      html += `</div>`;

      if (
        gameState.status === "BOOKING_OPEN" &&
        !t.isBooked &&
        !t.isFullHousieWinner
      ) {
        html += `<button class="wa-book-btn" onclick="openWhatsAppBooking('${t.id}')">📲 Book via WhatsApp</button>`;
      }

      html += `</div>`;
    }
  });

  grid.innerHTML = html;
}

function renderWARanges() {
  const container = document.getElementById("waRangesList");
  if (!container) return;
  let html = "";
  waRanges.forEach((range, idx) => {
    html += `
      <div class="wa-range-item">
        <input type="text" class="range-start" value="${range.start}" placeholder="Start (T-01)" data-index="${idx}">
        <input type="text" class="range-end" value="${range.end}" placeholder="End (T-50)" data-index="${idx}">
        <input type="text" class="range-number" value="${range.number}" placeholder="WhatsApp number" data-index="${idx}">
        <button class="btn btn-danger" onclick="removeRange(${idx})">Remove</button>
      </div>
    `;
  });
  container.innerHTML = html;
}

// ---------- WHATSAPP FUNCTIONS ----------
function getWhatsAppNumberForTicket(ticketId) {
  try {
    const num = parseInt(ticketId.split("-")[1]);
    if (isNaN(num)) return "917629048752";
    for (let range of waRanges) {
      const start = parseInt(range.start.split("-")[1]);
      const end = parseInt(range.end.split("-")[1]);
      if (num >= start && num <= end) {
        return range.number.replace(/[\s\-\(\)\+]/g, "");
      }
    }
  } catch (e) {
    console.error("Error parsing ticket ID:", e);
  }
  return "917629048752";
}

function openWhatsAppBooking(ticketId) {
  const number = getWhatsAppNumberForTicket(ticketId);
  const message = encodeURIComponent(`Hi, I want to book ticket ${ticketId}`);
  const url = `https://wa.me/${number}?text=${message}`;
  window.open(url, "_blank");
}

function addRange() {
  waRanges.push({ start: "T-01", end: "T-50", number: "" });
  renderWARanges();
}

function removeRange(index) {
  waRanges.splice(index, 1);
  renderWARanges();
  saveWARanges();
}

function saveWARanges() {
  const newRanges = [];
  let valid = true;
  document.querySelectorAll(".wa-range-item").forEach((item, idx) => {
    const start = item.querySelector(".range-start").value.trim();
    const end = item.querySelector(".range-end").value.trim();
    let number = item.querySelector(".range-number").value.trim();
    if (!start || !end || !number) {
      alert(`Range ${idx + 1}: All fields required`);
      valid = false;
      return;
    }
    number = number.replace(/[\s\-\(\)\+]/g, "");
    newRanges.push({ start, end, number });
  });
  if (valid && newRanges.length > 0) {
    waRanges = newRanges;
    localStorage.setItem("waRanges", JSON.stringify(waRanges));
    alert("WhatsApp ranges saved!");
  }
}

function testWARanges() {
  console.log("Testing WhatsApp ranges:");
  ["T-01", "T-25", "T-50", "T-51"].forEach((id) => {
    console.log(`${id} -> ${getWhatsAppNumberForTicket(id)}`);
  });
  alert("Check console (F12) for test results");
}

// ---------- INLINE BOOKING HANDLERS ----------
function openInlineBooking(ticketId) {
  activeBookingTicketId = ticketId;
  activeEditTicketId = null;
  renderHost();
  setTimeout(() => {
    const input = document.getElementById(`inline-name-${ticketId}`);
    if (input) input.focus();
  }, 50);
}

function confirmInlineBooking(ticketId) {
  const input = document.getElementById(`inline-name-${ticketId}`);
  const name = input ? input.value.trim() : "";
  if (!name) {
    alert("Please enter a player name");
    return;
  }
  socket.emit("host:bookTicket", { ticketId, playerName: name });
  activeBookingTicketId = null;
  renderHost();
}

function cancelInlineBooking() {
  activeBookingTicketId = null;
  renderHost();
}

function openInlineEdit(ticketId, currentName) {
  activeEditTicketId = ticketId;
  activeBookingTicketId = null;
  renderHost();
  setTimeout(() => {
    const input = document.getElementById(`inline-edit-${ticketId}`);
    if (input) {
      input.value = currentName;
      input.focus();
    }
  }, 50);
}

function confirmInlineEdit(ticketId) {
  const input = document.getElementById(`inline-edit-${ticketId}`);
  const name = input ? input.value.trim() : "";
  if (!name) {
    alert("Please enter a player name");
    return;
  }
  socket.emit("host:editBooking", { ticketId, newPlayerName: name });
  activeEditTicketId = null;
  renderHost();
}

function cancelInlineEdit() {
  activeEditTicketId = null;
  renderHost();
}

function unbookTicket(ticketId) {
  if (confirm("Release this ticket?")) {
    socket.emit("host:unbookTicket", { ticketId });
  }
}

// ---------- COUNTDOWN & TTS ----------
function speak(text) {
  if (!window.speechSynthesis) return;
  if (currentUtterance) window.speechSynthesis.cancel();
  currentUtterance = new SpeechSynthesisUtterance(text);
  currentUtterance.lang = "en-US";
  currentUtterance.rate = 1;
  window.speechSynthesis.speak(currentUtterance);
}

function handleCountdownTimer() {
  if (countdownInterval) clearInterval(countdownInterval);
  if (gameState.status !== "COUNTDOWN" || !gameState.countdownEndTime) return;

  lastSpokenCountdownSecond = -1;
  countdownInterval = setInterval(() => {
    const remaining = Math.max(
      0,
      Math.floor((gameState.countdownEndTime - Date.now()) / 1000),
    );
    document.getElementById("hostCountdownNumber").textContent = remaining;
    document.getElementById("playerCountdownNumber").textContent = remaining;

    if (
      remaining <= 5 &&
      remaining > 0 &&
      remaining !== lastSpokenCountdownSecond
    ) {
      speak(remaining.toString());
      lastSpokenCountdownSecond = remaining;
    } else if (remaining === 0 && lastSpokenCountdownSecond !== 0) {
      speak("Game started!");
      lastSpokenCountdownSecond = 0;
    }

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }, 500);
}

// ---------- POPUP & STICKY ----------
function showPopupNumber(number) {
  if (isHostAuthenticated) return;
  const container = document.getElementById("popupContainer");
  const popup = document.createElement("div");
  popup.className = "popup-number";
  popup.textContent = number;
  container.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);
}

function updateStickyNumber(number) {
  document.getElementById("hostCurrentNumberValue").textContent = number;
  document.getElementById("playerCurrentNumberValue").textContent = number;
}

function toggleWinnersVisibility() {
  const hostWinners = document.getElementById("hostWinnersSection");
  const playerWinners = document.getElementById("playerWinnersSection");
  const hasWinners = gameState.fullHousieWinners.length > 0;
  if (hostWinners) hostWinners.style.display = hasWinners ? "block" : "none";
  if (playerWinners)
    playerWinners.style.display = hasWinners ? "block" : "none";
}

function updateStatusBadges() {
  const badges = ["statusBadge", "playerStatusBadge"];
  badges.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = gameState.status.replace(/_/g, " ");
      el.className = "status-badge";
      if (gameState.status === "BOOKING_OPEN") el.classList.add("booking");
      else if (gameState.status === "COUNTDOWN") el.classList.add("countdown");
      else if (gameState.status === "RUNNING") el.classList.add("running");
      else if (gameState.status === "COMPLETED") el.classList.add("completed");
    }
  });
}

function updateBackButton() {
  const backBtn = document.getElementById("backToHostBtn");
  if (
    isHostAuthenticated &&
    document.getElementById("playerPanel").style.display !== "none"
  ) {
    backBtn.classList.remove("hidden");
  } else {
    backBtn.classList.add("hidden");
  }
}

// ---------- MODAL FUNCTIONS ----------
function showWinnerModal(ticketId) {
  const ticket = gameState.tickets.find((t) => t.id === ticketId);
  const winner = gameState.fullHousieWinners.find(
    (w) => w.ticketId === ticketId,
  );
  if (!ticket || !winner) return;

  const modal = document.getElementById("winnerModal");
  document.getElementById("modalWinnerInfo").innerHTML = `
    <div><strong>${winner.playerName}</strong> - ${ticketId}</div>
    <div>Winner #${winner.order} • ${winner.winTime}</div>
  `;
  let gridHtml = "";
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      const num = ticket.numbers[r][c];
      if (num === 0) {
        gridHtml += '<div class="modal-ticket-cell empty"></div>';
      } else {
        const marked = gameState.calledNumbers.includes(num) ? "marked" : "";
        gridHtml += `<div class="modal-ticket-cell ${marked}">${num}</div>`;
      }
    }
  }
  document.getElementById("modalTicketGrid").innerHTML = gridHtml;
  document.getElementById("modalCalledList").innerHTML =
    `<strong>Called at win:</strong> ${winner.calledNumbersAtWin.join(", ")}`;
  modal.classList.add("show");
}

function showTicketGridModal() {
  const modal = document.getElementById("ticketGridModal");
  const container = document.getElementById("ticketGridContainer");
  if (!container) return;
  let html = "";
  gameState.tickets.forEach((t) => {
    const num = t.id.split("-")[1];
    const bookedClass = t.isBooked ? "booked" : "";
    html += `<div class="ticket-grid-item ${bookedClass}">${num}</div>`;
  });
  container.innerHTML = html;
  modal.classList.add("show");
}

function printPdfFromGrid() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  doc.setFontSize(16);
  doc.text("Ticket Grid", 105, 15, { align: "center" });
  doc.setFontSize(10);

  const total = gameState.tickets.length;
  const cols = 10;
  const cellSize = 15;
  const startX = 20;
  const startY = 30;
  const ticketsPerPage = Math.floor((280 - startY) / cellSize) * cols;

  let page = 1;
  for (let i = 0; i < total; i++) {
    if (i > 0 && i % ticketsPerPage === 0) {
      doc.addPage();
      page++;
      doc.setFontSize(16);
      doc.text("Ticket Grid", 105, 15, { align: "center" });
      doc.setFontSize(10);
    }
    const ticket = gameState.tickets[i];
    const col = i % cols;
    const rowOnPage =
      Math.floor(i / cols) - (page - 1) * Math.floor(ticketsPerPage / cols);
    const x = startX + col * cellSize;
    const y = startY + rowOnPage * cellSize;

    doc.setDrawColor(0);
    doc.setLineWidth(0.2);
    doc.rect(x, y, cellSize, cellSize);
    if (ticket.isBooked) {
      doc.setFillColor(198, 246, 213);
      doc.rect(x, y, cellSize, cellSize, "F");
    }
    doc.setTextColor(0);
    doc.text(ticket.id.split("-")[1], x + cellSize / 2, y + cellSize / 2, {
      align: "center",
      baseline: "middle",
    });
  }

  const pdfBlob = doc.output("blob");
  const pdfUrl = URL.createObjectURL(pdfBlob);
  window.open(pdfUrl);
}

function parseSequence(input) {
  if (!input.trim()) return [];
  const parts = input.split(/[,\s]+/).filter((s) => s.trim() !== "");
  const numbers = [];
  const seen = new Set();
  for (let p of parts) {
    const num = Number(p);
    if (isNaN(num) || num < 1 || num > 90)
      throw new Error(`Invalid: ${p} (must be 1-90)`);
    if (seen.has(num)) throw new Error(`Duplicate: ${num}`);
    seen.add(num);
    numbers.push(num);
  }
  return numbers;
}

// ---------- EVENT LISTENERS ----------
document.addEventListener("DOMContentLoaded", () => {
  // Login
  document.getElementById("loginBtn").addEventListener("click", () => {
    const user = document.getElementById("username").value.trim();
    const pass = document.getElementById("password").value.trim();
    if (!user || !pass) {
      document.getElementById("loginError").textContent =
        "Enter username and password";
      document.getElementById("loginError").style.display = "block";
      return;
    }
    document.getElementById("loginError").style.display = "none";
    socket.emit("host:login", { username: user, password: pass });
  });

  // Reconnect
  document.getElementById("reconnectBtn").addEventListener("click", () => {
    socket.connect();
    document.getElementById("loginError").textContent = "Reconnecting...";
  });

  // Logout
  document.getElementById("logoutBtn").addEventListener("click", () => {
    isHostAuthenticated = false;
    localStorage.removeItem("hostAuth");
    localStorage.removeItem("hostUser");
    localStorage.removeItem("hostPass");
    document.getElementById("dashboardSection").style.display = "none";
    document.getElementById("loginSection").style.display = "block";
  });

  // Create game
  document.getElementById("createGameBtn").addEventListener("click", () => {
    const count = parseInt(document.getElementById("ticketCount").value) || 50;
    socket.emit("host:createGame", { ticketCount: count });
  });

  // Set sequence
  document.getElementById("setSequenceBtn").addEventListener("click", () => {
    try {
      const seq = parseSequence(
        document.getElementById("customSequenceInput").value,
      );
      socket.emit("host:setSequence", { sequence: seq });
      document.getElementById("sequenceError").textContent = "✅ Sequence set";
    } catch (e) {
      document.getElementById("sequenceError").textContent = "❌ " + e.message;
    }
  });

  // Start game (countdown modal)
  document.getElementById("startGameBtn").addEventListener("click", () => {
    document.getElementById("countdownModal").classList.add("show");
  });

  // Countdown modal buttons
  document
    .getElementById("confirmCountdownBtn")
    .addEventListener("click", () => {
      const input = document.getElementById("countdownInput").value;
      document.getElementById("countdownModal").classList.remove("show");
      socket.emit("host:startCountdown", { duration: input });
    });
  document
    .getElementById("cancelCountdownBtn")
    .addEventListener("click", () => {
      document.getElementById("countdownModal").classList.remove("show");
    });
  document.querySelectorAll(".quick-select-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      document.getElementById("countdownInput").value = e.target.dataset.time;
    });
  });

  // Reset game
  document.getElementById("resetGameBtn").addEventListener("click", () => {
    if (confirm("Reset game? All data will be lost.")) {
      socket.emit("host:resetGame");
    }
  });

  // Search inputs
  document.getElementById("hostSearchInput").addEventListener("input", (e) => {
    hostSearchTerm = e.target.value;
    renderHost();
  });
  document
    .getElementById("playerSearchInput")
    .addEventListener("input", (e) => {
      playerSearchTerm = e.target.value;
      renderPlayer();
    });

  // WhatsApp ranges
  document.getElementById("addRangeBtn").addEventListener("click", addRange);
  document
    .getElementById("saveWARangesBtn")
    .addEventListener("click", saveWARanges);
  document
    .getElementById("testWARangesBtn")
    .addEventListener("click", testWARanges);

  // PDF
  document
    .getElementById("generatePdfBtn")
    .addEventListener("click", showTicketGridModal);
  document
    .getElementById("cancelGridModalBtn")
    .addEventListener("click", () => {
      document.getElementById("ticketGridModal").classList.remove("show");
    });
  document.getElementById("printPdfBtn").addEventListener("click", () => {
    printPdfFromGrid();
  });

  // Tab navigation
  document.getElementById("mobilePlayerTab").addEventListener("click", () => {
    document.getElementById("hostPanel").style.display = "none";
    document.getElementById("playerPanel").style.display = "block";
    document.getElementById("tabBar").classList.add("hidden");
    updateUI();
  });
  document.getElementById("backToHostBtn").addEventListener("click", () => {
    document.getElementById("hostPanel").style.display = "block";
    document.getElementById("playerPanel").style.display = "none";
    document.getElementById("tabBar").classList.remove("hidden");
    updateUI();
  });

  // Close modals when clicking X or overlay
  document.querySelectorAll(".close").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const modal = e.target.closest(".modal-overlay");
      if (modal) modal.classList.remove("show");
    });
  });
  window.addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-overlay")) {
      e.target.classList.remove("show");
    }
  });

  // Collapsible toggles
  const toggleWABtn = document.getElementById("toggleWARangesBtn");
  const waContent = document.getElementById("waRangesContent");
  if (toggleWABtn && waContent) {
    const isCollapsed = localStorage.getItem("waRangesCollapsed") === "true";
    if (isCollapsed) {
      waContent.classList.add("collapsed");
      toggleWABtn.textContent = "▶";
    }
    toggleWABtn.addEventListener("click", () => {
      waContent.classList.toggle("collapsed");
      toggleWABtn.textContent = waContent.classList.contains("collapsed")
        ? "▶"
        : "▼";
      localStorage.setItem(
        "waRangesCollapsed",
        waContent.classList.contains("collapsed"),
      );
    });
  }

  const toggleGameCtrlBtn = document.getElementById("toggleGameControlBtn");
  const gameCtrlContent = document.getElementById("gameControlContent");
  if (toggleGameCtrlBtn && gameCtrlContent) {
    const isCollapsed = localStorage.getItem("gameControlCollapsed") === "true";
    if (isCollapsed) {
      gameCtrlContent.classList.add("collapsed");
      toggleGameCtrlBtn.textContent = "▶";
    }
    toggleGameCtrlBtn.addEventListener("click", () => {
      gameCtrlContent.classList.toggle("collapsed");
      toggleGameCtrlBtn.textContent = gameCtrlContent.classList.contains(
        "collapsed",
      )
        ? "▶"
        : "▼";
      localStorage.setItem(
        "gameControlCollapsed",
        gameCtrlContent.classList.contains("collapsed"),
      );
    });
  }

  // Initial route
  if (window.location.pathname === "/host") {
    document.getElementById("hostPanel").style.display = "block";
    document.getElementById("playerPanel").style.display = "none";
    document.getElementById("tabBar").classList.remove("hidden");
  } else {
    document.getElementById("hostPanel").style.display = "none";
    document.getElementById("playerPanel").style.display = "block";
    document.getElementById("tabBar").classList.add("hidden");
  }
});
