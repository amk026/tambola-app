const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path"); // already present

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static("public"));

// 👇 FIXED: Catch‑all middleware (no path pattern, so no parsing error)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Game State ----------
let gameState = {
  tickets: [],
  calledNumbers: [],
  fullHousieWinners: [], // Array of winner objects (max 5)
  winners: [], // For backward compatibility
  status: "NO_ACTIVE_GAME",
  drawSequence: [],
  drawIndex: 0,
  gameCreatedAt: null,
  gameStartedAt: null,
  gameEndedAt: null,
  countdownEndTime: null,
  lastCallTime: null,
  maxWinners: 5,
  gameEndReason: null,
};

// Timer reference
let nextCallTimeout = null;

function broadcastState() {
  io.emit("gameState", gameState);
}

// ---------- Tambola Generator ----------
const TambolaGenerator = {
  generateTicket() {
    let colCounts = new Array(9).fill(1);
    let sum = 9;
    while (sum < 15) {
      let col = Math.floor(Math.random() * 9);
      if (colCounts[col] < 3) {
        colCounts[col]++;
        sum++;
      }
    }
    let rowRemaining = [5, 5, 5];
    let colRows = Array(9)
      .fill()
      .map(() => []);
    let success = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      rowRemaining = [5, 5, 5];
      colRows = Array(9)
        .fill()
        .map(() => []);
      success = true;
      let cols = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      for (let i = cols.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [cols[i], cols[j]] = [cols[j], cols[i]];
      }
      for (let c of cols) {
        let k = colCounts[c];
        let availableRows = [];
        for (let r = 0; r < 3; r++)
          if (rowRemaining[r] > 0) availableRows.push(r);
        if (availableRows.length < k) {
          success = false;
          break;
        }
        for (let i = availableRows.length - 1; i > 0; i--) {
          let j = Math.floor(Math.random() * (i + 1));
          [availableRows[i], availableRows[j]] = [
            availableRows[j],
            availableRows[i],
          ];
        }
        let selected = availableRows.slice(0, k).sort((a, b) => a - b);
        colRows[c] = selected;
        for (let r of selected) rowRemaining[r]--;
      }
      if (success && rowRemaining.every((v) => v === 0)) break;
    }
    if (!success || !rowRemaining.every((v) => v === 0)) {
      colCounts = [2, 2, 2, 2, 2, 2, 1, 1, 1];
      colRows = [[0, 1], [1, 2], [0, 2], [0, 1], [1, 2], [0, 2], [0], [1], [2]];
    }
    let ticket = Array(3)
      .fill()
      .map(() => Array(9).fill(0));
    for (let c = 0; c < 9; c++) for (let r of colRows[c]) ticket[r][c] = 1;
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
      let rows = colRows[c];
      if (rows.length === 0) continue;
      let [min, max] = ranges[c];
      let pool = [];
      for (let n = min; n <= max; n++) pool.push(n);
      for (let i = pool.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      let numbers = pool.slice(0, rows.length).sort((a, b) => a - b);
      for (let i = 0; i < rows.length; i++) ticket[rows[i]][c] = numbers[i];
    }
    return ticket;
  },

  generateTickets(count) {
    let tickets = [];
    for (let i = 1; i <= count; i++)
      tickets.push({
        id: `T-${i.toString().padStart(2, "0")}`,
        numbers: this.generateTicket(),
        isBooked: false,
        bookedBy: null,
        isFullHousieWinner: false,
        fullHousieOrder: null,
        winTime: null,
        winningPattern: null,
      });
    return tickets;
  },
};

// ---------- Winner Detection Functions ----------

function checkForFullHousieWinners() {
  // Stop if we already have 5 winners
  if (gameState.fullHousieWinners.length >= gameState.maxWinners) {
    return;
  }

  // Get all booked tickets that haven't won yet
  const activeTickets = gameState.tickets.filter(
    (t) => t.isBooked && !t.isFullHousieWinner,
  );

  // Check each ticket
  for (const ticket of activeTickets) {
    // Get all non-zero numbers on ticket
    const ticketNumbers = ticket.numbers.flat().filter((n) => n !== 0);

    // Check if ALL numbers have been called
    const allNumbersMarked = ticketNumbers.every((num) =>
      gameState.calledNumbers.includes(num),
    );

    if (allNumbersMarked) {
      // This ticket wins FULL HOUSIE!
      declareWinner(ticket);

      // Stop if we now have 5 winners
      if (gameState.fullHousieWinners.length >= gameState.maxWinners) {
        break;
      }
    }
  }

  // If we reached 5 winners, end the game
  if (gameState.fullHousieWinners.length >= gameState.maxWinners) {
    endGameDueToMaxWinners();
  }
}

function declareWinner(ticket) {
  // Calculate winner order
  const winnerOrder = gameState.fullHousieWinners.length + 1;

  // Update ticket object
  ticket.isFullHousieWinner = true;
  ticket.fullHousieOrder = winnerOrder;
  ticket.winTime = new Date().toISOString();
  ticket.winningPattern = "FULL HOUSIE";

  // Create winner object
  const winner = {
    order: winnerOrder,
    ticketId: ticket.id,
    playerName: ticket.bookedBy,
    pattern: "FULL HOUSIE",
    winTime: new Date().toLocaleTimeString(),
    winTimestamp: Date.now(),
    ticketNumbers: ticket.numbers,
    calledNumbersAtWin: [...gameState.calledNumbers],
  };

  // Add to winners array
  gameState.fullHousieWinners.push(winner);

  // Update legacy winners array
  gameState.winners.push({
    ticketId: ticket.id,
    playerName: ticket.bookedBy,
    winnerOrder: winnerOrder,
    pattern: "FULL HOUSIE",
    declaredAt: new Date().toLocaleTimeString(),
  });

  // Log the win
  console.log(
    `🏆 WINNER #${winnerOrder}: ${ticket.bookedBy} with ticket ${ticket.id}`,
  );

  // Broadcast special winner event
  io.emit("newFullHousieWinner", {
    winner: winner,
    totalWinners: gameState.fullHousieWinners.length,
    maxWinners: gameState.maxWinners,
    gameContinues: gameState.fullHousieWinners.length < gameState.maxWinners,
  });

  // Broadcast full state update
  broadcastState();
}

function endGameDueToMaxWinners() {
  console.log("🏁 GAME ENDED - 5 FULL HOUSIE WINNERS REACHED");

  // Update game state
  gameState.status = "COMPLETED";
  gameState.gameEndedAt = Date.now();
  gameState.gameEndReason = "FULL_HOUSIE_COMPLETE";

  // Clear any scheduled calls
  if (nextCallTimeout) {
    clearTimeout(nextCallTimeout);
    nextCallTimeout = null;
  }

  // Send special game end event
  io.emit("gameEndedWithWinners", {
    winners: gameState.fullHousieWinners,
    totalWinners: gameState.fullHousieWinners.length,
    calledNumbers: gameState.calledNumbers.length,
    gameEndedAt: new Date().toLocaleTimeString(),
  });

  // Broadcast final state
  broadcastState();
}

// ---------- Game Logic ----------

function startCountdown(durationSeconds) {
  gameState.status = "COUNTDOWN";
  gameState.countdownEndTime = Date.now() + durationSeconds * 1000;
  gameState.gameStartedAt = null;
  gameState.drawIndex = 0;
  broadcastState();

  setTimeout(() => {
    if (gameState.status === "COUNTDOWN") {
      actuallyStartGame();
    }
  }, durationSeconds * 1000);
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
  // Check if game is still running
  if (gameState.status !== "RUNNING") return;

  // Check if we already have 5 winners
  if (gameState.fullHousieWinners.length >= gameState.maxWinners) {
    endGameDueToMaxWinners();
    return;
  }

  // Check if we've called all numbers
  if (gameState.drawIndex >= gameState.drawSequence.length) {
    endGame("SEQUENCE_COMPLETE");
    return;
  }

  const now = Date.now();
  const timeUntilNextCall = Math.max(0, 3000 - (now - gameState.lastCallTime));

  nextCallTimeout = setTimeout(() => {
    if (gameState.status !== "RUNNING") return;

    // Check again for 5 winners before calling next number
    if (gameState.fullHousieWinners.length >= gameState.maxWinners) {
      endGameDueToMaxWinners();
      return;
    }

    const number = gameState.drawSequence[gameState.drawIndex++];
    if (!gameState.calledNumbers.includes(number)) {
      gameState.calledNumbers.push(number);
    }
    gameState.lastCallTime = Date.now();

    // Check for winners after each call
    checkForFullHousieWinners();

    broadcastState();
    scheduleNextCall();
  }, timeUntilNextCall);
}

function endGame(reason) {
  gameState.status = "COMPLETED";
  gameState.gameEndedAt = Date.now();
  gameState.gameEndReason = reason;

  if (nextCallTimeout) {
    clearTimeout(nextCallTimeout);
    nextCallTimeout = null;
  }

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
    maxWinners: 5,
    gameEndReason: null,
  };

  if (nextCallTimeout) {
    clearTimeout(nextCallTimeout);
    nextCallTimeout = null;
  }

  broadcastState();
}

// ---------- Socket.IO with Authentication ----------
io.on("connection", (socket) => {
  console.log("a user connected");

  // Send current state immediately
  socket.emit("gameState", gameState);

  // Host login event
  socket.on("host:login", ({ username, password }) => {
    if (username === "admin" && password === "myNewSecret") {
      socket.isHost = true;
      socket.emit("host:login:success");
      console.log("Host authenticated");
    } else {
      socket.emit("host:login:failure", { message: "Invalid credentials" });
    }
  });

  // Host-only events checker
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
      // Parse duration (seconds or minutes)
      let seconds = 30; // default
      if (typeof duration === "number") {
        seconds = duration;
      } else if (typeof duration === "string") {
        if (duration.endsWith("m")) {
          seconds = parseInt(duration) * 60;
        } else {
          seconds = parseInt(duration);
        }
      }
      // Validate
      seconds = Math.max(5, Math.min(300, seconds));
      startCountdown(seconds);
    }
  });

  socket.on("host:resetGame", () => {
    if (!requireHost()) return;
    resetGame();
  });

  socket.on("host:bookTicket", ({ ticketId, playerName }) => {
    if (!requireHost()) return;

    // Bookings allowed only during BOOKING_OPEN
    if (gameState.status !== "BOOKING_OPEN") {
      socket.emit("host:error", {
        message: "Bookings closed - game in progress or ended",
      });
      return;
    }

    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (ticket && !ticket.isBooked && !ticket.isFullHousieWinner) {
      ticket.isBooked = true;
      ticket.bookedBy = playerName;
      broadcastState();
    }
  });

  // Player search - no authentication needed
  socket.on("player:search", ({ query }) => {
    // Just emit back the current state - search happens client-side
    socket.emit("gameState", gameState);
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
