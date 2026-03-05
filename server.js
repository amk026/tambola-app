const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Catch-all to serve index.html for client-side routing
app.get("/*path", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Game State ----------
let gameState = {
  tickets: [],
  calledNumbers: [],
  fullHousieWinners: [],
  winners: [],
  status: "NO_ACTIVE_GAME", // NO_ACTIVE_GAME, BOOKING_OPEN, COUNTDOWN, RUNNING, COMPLETED
  drawSequence: [],
  drawIndex: 0,
  gameCreatedAt: null,
  gameStartedAt: null,
  gameEndedAt: null,
  countdownEndTime: null,
  lastCallTime: null,
  maxWinners: 2, // number of prize ranks (1st…5th)
  currentPrizeRank: 1, // next prize rank to award
  gameEndReason: null,
};

let nextCallTimeout = null;
let countdownTimeout = null;

// ---------- Helper Functions ----------
function broadcastState() {
  io.emit("gameState", gameState);
}

// Tambola ticket generator (improved)
const TambolaGenerator = {
  // Generate a single valid Tambola ticket
  generateTicket() {
    const MAX_ATTEMPTS = 100;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Step 1: Generate random column counts (1-3 each, sum 15)
      let colCounts = new Array(9).fill(1); // start with all 1's (sum = 9)
      let remaining = 6; // need 6 more to reach 15
      while (remaining > 0) {
        let col = Math.floor(Math.random() * 9);
        if (colCounts[col] < 3) {
          colCounts[col]++;
          remaining--;
        }
      }

      // Step 2: Create empty ticket (3x9) and remaining counters
      let ticket = Array(3)
        .fill()
        .map(() => Array(9).fill(0));
      let rowRemaining = [5, 5, 5];
      let colRemaining = [...colCounts];

      // Step 3: Greedily place 1's (numbers) into cells
      let placed = 0;
      while (placed < 15) {
        // Pick a random row that still needs numbers
        let rowsWithSpace = [];
        for (let r = 0; r < 3; r++) {
          if (rowRemaining[r] > 0) rowsWithSpace.push(r);
        }
        if (rowsWithSpace.length === 0) break; // should not happen

        let r = rowsWithSpace[Math.floor(Math.random() * rowsWithSpace.length)];

        // Find columns that still need numbers and are empty in this row
        let validCols = [];
        for (let c = 0; c < 9; c++) {
          if (colRemaining[c] > 0 && ticket[r][c] === 0) validCols.push(c);
        }
        if (validCols.length === 0) {
          // Dead end – restart
          break;
        }

        let c = validCols[Math.floor(Math.random() * validCols.length)];
        ticket[r][c] = 1;
        rowRemaining[r]--;
        colRemaining[c]--;
        placed++;
      }

      // Check if we successfully placed all 15 numbers
      if (placed === 15) {
        // Step 4: Fill numbers based on column ranges
        const ranges = [
          [1, 9],
          [10, 19],
          [20, 29],
          [30, 39],
          [40, 49],
          [50, 59],
          [60, 69],
          [70, 79],
          [80, 90],
        ];

        for (let c = 0; c < 9; c++) {
          // Find rows that have a number in this column
          let rows = [];
          for (let r = 0; r < 3; r++) {
            if (ticket[r][c] === 1) rows.push(r);
          }
          if (rows.length === 0) continue;

          let [min, max] = ranges[c];
          // Generate pool of possible numbers
          let pool = [];
          for (let n = min; n <= max; n++) pool.push(n);
          // Shuffle pool
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          // Take required amount and sort ascending
          let numbers = pool.slice(0, rows.length).sort((a, b) => a - b);
          // Assign to rows (rows are sorted ascending, numbers are sorted ascending)
          for (let i = 0; i < rows.length; i++) {
            ticket[rows[i]][c] = numbers[i];
          }
        }

        return ticket;
      }
      // Otherwise, retry
    }
    throw new Error("Failed to generate a valid ticket after many attempts");
  },

  // Generate multiple tickets
  generateTickets(count) {
    let tickets = [];
    for (let i = 1; i <= count; i++) {
      tickets.push({
        id: `T-${i.toString().padStart(2, "0")}`,
        numbers: this.generateTicket(),
        isBooked: false,
        bookedBy: null,
        isPending: false,
        pendingPlayerName: null,
        isFullHousieWinner: false,
        fullHousieOrder: null,
        winTime: null,
        winningPattern: null,
      });
    }
    return tickets;
  },
};

// Winner detection – handles multiple simultaneous winners per rank
function checkForFullHousieWinners() {
  // Stop if we already awarded all prizes
  if (gameState.currentPrizeRank > gameState.maxWinners) return;

  // Find all booked, not‑yet‑winner tickets that are now fully marked
  const activeTickets = gameState.tickets.filter(
    (t) => t.isBooked && !t.isFullHousieWinner,
  );
  const newWinners = [];

  for (const ticket of activeTickets) {
    const ticketNumbers = ticket.numbers.flat().filter((n) => n !== 0);
    const allMarked = ticketNumbers.every((num) =>
      gameState.calledNumbers.includes(num),
    );
    if (allMarked) {
      newWinners.push(ticket);
    }
  }

  if (newWinners.length === 0) return;

  // All these winners get the same prize rank (currentPrizeRank)
  for (const ticket of newWinners) {
    declareWinner(ticket, gameState.currentPrizeRank);
  }

  // Move to next prize rank
  gameState.currentPrizeRank++;

  // If we have now awarded the last prize, end the game
  if (gameState.currentPrizeRank > gameState.maxWinners) {
    endGameDueToMaxWinners();
  }
}

function declareWinner(ticket, rank) {
  ticket.isFullHousieWinner = true;
  ticket.fullHousieOrder = rank;
  ticket.winTime = new Date().toISOString();
  ticket.winningPattern = "FULL HOUSIE";

  const winner = {
    order: rank,
    ticketId: ticket.id,
    playerName: ticket.bookedBy,
    pattern: "FULL HOUSIE",
    winTime: new Date().toLocaleTimeString(),
    winTimestamp: Date.now(),
    ticketNumbers: ticket.numbers,
    calledNumbersAtWin: [...gameState.calledNumbers],
  };

  gameState.fullHousieWinners.push(winner);
  gameState.winners.push({
    ticketId: ticket.id,
    playerName: ticket.bookedBy,
    winnerOrder: rank,
    pattern: "FULL HOUSIE",
    declaredAt: new Date().toLocaleTimeString(),
  });

  console.log(`🏆 WINNER (rank ${rank}): ${ticket.bookedBy} (${ticket.id})`);
  io.emit("newFullHousieWinner", winner);
  broadcastState();
}

function endGameDueToMaxWinners() {
  console.log("🏁 GAME ENDED – All prize ranks awarded");
  gameState.status = "COMPLETED";
  gameState.gameEndedAt = Date.now();
  gameState.gameEndReason = "FULL_HOUSIE_COMPLETE";
  clearTimeouts();
  broadcastState();
}

function clearTimeouts() {
  if (nextCallTimeout) {
    clearTimeout(nextCallTimeout);
    nextCallTimeout = null;
  }
  if (countdownTimeout) {
    clearTimeout(countdownTimeout);
    countdownTimeout = null;
  }
}

// Countdown & game start
function startCountdown(seconds) {
  gameState.status = "COUNTDOWN";
  gameState.countdownEndTime = Date.now() + seconds * 1000;
  gameState.gameStartedAt = null;
  gameState.drawIndex = 0;
  broadcastState();
  countdownTimeout = setTimeout(() => {
    if (gameState.status === "COUNTDOWN") {
      actuallyStartGame();
    }
  }, seconds * 1000);
}

function actuallyStartGame() {
  gameState.status = "RUNNING";
  gameState.gameStartedAt = Date.now();
  gameState.countdownEndTime = null;
  gameState.lastCallTime = Date.now();
  broadcastState();
  scheduleNextCall();
}

function scheduleNextCall() {
  if (gameState.status !== "RUNNING") return;

  // Stop if all prize ranks have been awarded
  if (gameState.currentPrizeRank > gameState.maxWinners) {
    endGameDueToMaxWinners();
    return;
  }

  // If we've reached the end of the draw sequence, end the game
  if (gameState.drawIndex >= gameState.drawSequence.length) {
    endGame("SEQUENCE_COMPLETE");
    return;
  }

  const now = Date.now();
  const timeUntilNextCall = Math.max(0, 6000 - (now - gameState.lastCallTime));

  nextCallTimeout = setTimeout(() => {
    if (gameState.status !== "RUNNING") return;

    // Re-check prize rank condition (in case winners were declared during the wait)
    if (gameState.currentPrizeRank > gameState.maxWinners) {
      endGameDueToMaxWinners();
      return;
    }

    const number = gameState.drawSequence[gameState.drawIndex++];
    if (!gameState.calledNumbers.includes(number)) {
      gameState.calledNumbers.push(number);
    }
    gameState.lastCallTime = Date.now();

    // Check for new winners after this number
    checkForFullHousieWinners();

    broadcastState();
    scheduleNextCall();
  }, timeUntilNextCall);
}

function endGame(reason) {
  gameState.status = "COMPLETED";
  gameState.gameEndedAt = Date.now();
  gameState.gameEndReason = reason;
  clearTimeouts();
  broadcastState();
}

function resetGame() {
  gameState = {
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
    maxWinners: 2,
    currentPrizeRank: 1,
    gameEndReason: null,
  };
  clearTimeouts();
  broadcastState();
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  console.log("a user connected");
  socket.emit("gameState", gameState);

  // Host login
  socket.on("host:login", ({ username, password }) => {
    console.log("Login attempt:", username);
    if (username === "admin" && password === "myNewSecret") {
      socket.isHost = true;
      console.log("Login successful for:", username);
      socket.emit("host:login:success", { message: "Login successful" });
    } else {
      console.log("Login failed for:", username);
      socket.emit("host:login:failure", { message: "Invalid credentials" });
    }
  });

  const requireHost = (callback) => {
    if (!socket.isHost) {
      socket.emit("host:error", { message: "Not authenticated" });
      return false;
    }
    return true;
  };

  socket.on("host:createGame", ({ ticketCount }) => {
    if (!requireHost()) return;
    const tickets = TambolaGenerator.generateTickets(ticketCount);
    gameState.tickets = tickets;
    gameState.calledNumbers = [];
    gameState.fullHousieWinners = [];
    gameState.winners = [];
    gameState.drawSequence = [];
    gameState.drawIndex = 0;
    gameState.status = "BOOKING_OPEN";
    gameState.gameCreatedAt = Date.now();
    gameState.gameStartedAt = null;
    gameState.gameEndedAt = null;
    gameState.countdownEndTime = null;
    gameState.lastCallTime = null;
    gameState.currentPrizeRank = 1;
    gameState.gameEndReason = null;
    broadcastState();
  });

  socket.on("host:setSequence", ({ sequence }) => {
    if (!requireHost()) return;
    gameState.drawSequence = sequence;
    broadcastState();
  });

  socket.on("host:startCountdown", ({ duration }) => {
    if (!requireHost()) return;
    if (
      gameState.status === "BOOKING_OPEN" &&
      gameState.tickets.filter((t) => t.isBooked).length > 0
    ) {
      let seconds = 30;
      if (typeof duration === "number") seconds = duration;
      else if (typeof duration === "string") {
        if (duration.endsWith("m")) seconds = parseInt(duration) * 60;
        else seconds = parseInt(duration);
      }
      seconds = Math.max(5, Math.min(300, seconds));
      startCountdown(seconds);
    }
  });

  socket.on("host:resetGame", () => {
    if (!requireHost()) return;
    resetGame();
  });

  // Host directly books a ticket (no pending)
  socket.on("host:bookTicket", ({ ticketId, playerName }) => {
    if (!requireHost()) return;
    if (gameState.status !== "BOOKING_OPEN") {
      socket.emit("host:error", { message: "Bookings closed" });
      return;
    }
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (
      ticket &&
      !ticket.isBooked &&
      !ticket.isFullHousieWinner &&
      !ticket.isPending
    ) {
      ticket.isBooked = true;
      ticket.bookedBy = playerName;
      broadcastState();
    }
  });

  // Host edits a booked ticket
  socket.on("host:editBooking", ({ ticketId, newPlayerName }) => {
    if (!requireHost()) return;
    if (gameState.status !== "BOOKING_OPEN") {
      socket.emit("host:error", { message: "Editing not allowed now" });
      return;
    }
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (ticket && ticket.isBooked && !ticket.isFullHousieWinner) {
      ticket.bookedBy = newPlayerName;
      broadcastState();
    }
  });

  // Host unbooks a ticket
  socket.on("host:unbookTicket", ({ ticketId }) => {
    if (!requireHost()) return;
    if (gameState.status !== "BOOKING_OPEN") {
      socket.emit("host:error", { message: "Unbooking not allowed now" });
      return;
    }
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (ticket && ticket.isBooked && !ticket.isFullHousieWinner) {
      ticket.isBooked = false;
      ticket.bookedBy = null;
      broadcastState();
    }
  });

  // Player requests a pending booking
  socket.on("player:requestBooking", ({ ticketId, playerName }) => {
    if (gameState.status !== "BOOKING_OPEN") {
      socket.emit("host:error", { message: "Bookings are closed" });
      return;
    }
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (!ticket) {
      socket.emit("host:error", { message: "Ticket not found" });
      return;
    }
    if (ticket.isBooked || ticket.isFullHousieWinner) {
      socket.emit("host:error", { message: "Ticket already booked or won" });
      return;
    }
    if (ticket.isPending) {
      socket.emit("host:error", { message: "Ticket already pending" });
      return;
    }
    ticket.isPending = true;
    ticket.pendingPlayerName = playerName;
    broadcastState();
  });

  // Host confirms a pending booking
  socket.on("host:confirmPending", ({ ticketId }) => {
    if (!requireHost()) return;
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (!ticket || !ticket.isPending) {
      socket.emit("host:error", {
        message: "No pending booking for this ticket",
      });
      return;
    }
    ticket.isBooked = true;
    ticket.bookedBy = ticket.pendingPlayerName;
    ticket.isPending = false;
    ticket.pendingPlayerName = null;
    broadcastState();
  });

  // Host cancels a pending booking
  socket.on("host:cancelPending", ({ ticketId }) => {
    if (!requireHost()) return;
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (!ticket || !ticket.isPending) {
      socket.emit("host:error", {
        message: "No pending booking for this ticket",
      });
      return;
    }
    ticket.isPending = false;
    ticket.pendingPlayerName = null;
    broadcastState();
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
