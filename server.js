const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static("public"));

// ---------- Game State ----------
let gameState = {
  tickets: [],
  calledNumbers: [],
  winners: [],
  status: "NO_ACTIVE_GAME",
  drawSequence: [],
  drawIndex: 0,
  gameCreatedAt: null,
  gameStartedAt: null,
  gameEndedAt: null,
  countdownEndTime: null,
  lastCallTime: null,
};

function broadcastState() {
  io.emit("gameState", gameState);
}

// ---------- Tambola Generator (unchanged) ----------
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
        isWinner: false,
        winnerOrder: null,
      });
    return tickets;
  },
};

// ---------- Game Logic ----------
function startCountdown() {
  gameState.status = "COUNTDOWN";
  gameState.countdownEndTime = Date.now() + 20000; // 20 seconds
  gameState.gameStartedAt = null;
  gameState.drawIndex = 0;
  broadcastState();

  setTimeout(() => {
    if (gameState.status === "COUNTDOWN") {
      actuallyStartGame();
    }
  }, 20000);
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
  if (
    gameState.winners.length >= 5 ||
    gameState.drawIndex >= gameState.drawSequence.length
  ) {
    endGame();
    return;
  }

  const now = Date.now();
  const timeUntilNextCall = Math.max(0, 3000 - (now - gameState.lastCallTime));
  setTimeout(() => {
    if (gameState.status !== "RUNNING") return;

    const number = gameState.drawSequence[gameState.drawIndex++];
    if (!gameState.calledNumbers.includes(number)) {
      gameState.calledNumbers.push(number);
    }
    gameState.lastCallTime = Date.now();
    checkWinners();
    broadcastState();
    scheduleNextCall();
  }, timeUntilNextCall);
}

function checkWinners() {
  let newWinner = false;
  gameState.tickets.forEach((t) => {
    if (!t.isBooked || t.isWinner) return;
    const numbers = t.numbers.flat().filter((n) => n !== 0);
    const marked = numbers.filter((n) => gameState.calledNumbers.includes(n));
    if (marked.length === numbers.length) {
      t.isWinner = true;
      t.winnerOrder = gameState.winners.length + 1;
      gameState.winners.push({
        ticketId: t.id,
        playerName: t.bookedBy,
        winnerOrder: t.winnerOrder,
        declaredAt: new Date().toLocaleTimeString(),
      });
      newWinner = true;
    }
  });
  if (newWinner) broadcastState();
  if (gameState.winners.length >= 5) endGame();
}

function endGame() {
  gameState.status = "COMPLETED";
  gameState.gameEndedAt = Date.now();
  broadcastState();
}

function resetGame() {
  gameState = {
    tickets: [],
    calledNumbers: [],
    winners: [],
    status: "NO_ACTIVE_GAME",
    drawSequence: [],
    drawIndex: 0,
    gameCreatedAt: null,
    gameStartedAt: null,
    gameEndedAt: null,
    countdownEndTime: null,
    lastCallTime: null,
  };
  broadcastState();
}

// ---------- Socket.IO with Authentication ----------
io.on("connection", (socket) => {
  console.log("a user connected");
  // Send current state immediately
  socket.emit("gameState", gameState);

  // Host login event
  socket.on("host:login", ({ username, password }) => {
    if (username === "admin" && password === "admin123") {
      socket.isHost = true;
      socket.emit("host:login:success");
      console.log("Host authenticated");
    } else {
      socket.emit("host:login:failure", { message: "Invalid credentials" });
    }
  });

  // All host-only events must check authentication
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
    gameState.winners = [];
    gameState.drawSequence = [];
    gameState.drawIndex = 0;
    gameState.status = "BOOKING_OPEN";
    gameState.gameCreatedAt = Date.now();
    gameState.gameStartedAt = null;
    gameState.gameEndedAt = null;
    gameState.countdownEndTime = null;
    gameState.lastCallTime = null;
    broadcastState();
  });

  socket.on("host:setSequence", ({ sequence }) => {
    if (!requireHost()) return;
    gameState.drawSequence = sequence;
    broadcastState();
  });

  socket.on("host:startCountdown", () => {
    if (!requireHost()) return;
    if (
      gameState.status === "BOOKING_OPEN" &&
      gameState.tickets.filter((t) => t.isBooked).length > 0
    ) {
      startCountdown();
    }
  });

  socket.on("host:resetGame", () => {
    if (!requireHost()) return;
    resetGame();
  });

  socket.on("host:bookTicket", ({ ticketId, playerName }) => {
    if (!requireHost()) return;
    const ticket = gameState.tickets.find((t) => t.id === ticketId);
    if (ticket && !ticket.isBooked && !ticket.isWinner) {
      ticket.isBooked = true;
      ticket.bookedBy = playerName;
      broadcastState();
    }
  });

  socket.on("disconnect", () => {
    console.log("user disconnected");
    // No need to clear authentication – next connection is fresh
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
