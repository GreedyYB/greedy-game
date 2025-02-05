const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Game configuration
const config = {
  STARTING_UNITS: 200,
  MIN_WAGER: 10,
  BANKRUPTCY_THRESHOLD: 20,
  TIMER_DURATION: 60,
  WAGER_TIMEOUT_PENALTY: true
};

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Game state
const playerSlots = [null, null];
const players = {};
let roundNumber = 0;
let timerInterval = null;
let isGameActive = true;

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // Assign player to slot
  let assignedSlot = null;
  if (!playerSlots[0]) {
    assignedSlot = 0;
    playerSlots[0] = socket.id;
    players[socket.id] = { 
      name: "Player 1", 
      units: config.STARTING_UNITS, 
      wager: null 
    };
    socket.emit("assign_name", { name: "Player 1", id: socket.id });
  } else if (!playerSlots[1]) {
    assignedSlot = 1;
    playerSlots[1] = socket.id;
    players[socket.id] = { 
      name: "Player 2", 
      units: config.STARTING_UNITS, 
      wager: null 
    };
    socket.emit("assign_name", { name: "Player 2", id: socket.id });
  } else {
    socket.emit("error_message", "Game is full");
    socket.disconnect();
    return;
  }

  // Notify players
  io.emit("player_joined", { id: socket.id, name: players[socket.id].name });

  // Start game if both players are ready
  if (playerSlots[0] && playerSlots[1]) {
    startGame();
  }

  // Wager handler
  socket.on("place_wager", (wager) => {
    if (!isGameActive) {
      socket.emit("error_message", "Game is not active");
      return;
    }

    const player = players[socket.id];
    if (!player || wager < config.MIN_WAGER || wager > player.units) {
      socket.emit("invalid_wager", `Wager must be between ${config.MIN_WAGER} and ${player.units}`);
      return;
    }

    player.wager = wager;
    io.emit("wager_placed", { playerId: socket.id, wager });

    // Check if both wagers are placed
    if (players[playerSlots[0]]?.wager !== null && players[playerSlots[1]]?.wager !== null) {
      clearInterval(timerInterval);
      calculateRoundWinner(playerSlots[0], playerSlots[1]);
    }
  });

  // Reset handler
  socket.on("reset_game", () => {
    resetGame();
    io.emit("game_reset");
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    const slotIndex = playerSlots.indexOf(socket.id);
    if (slotIndex !== -1) {
      playerSlots[slotIndex] = null;
      delete players[socket.id];
    }
    io.emit("player_left", { id: socket.id });
    if (!playerSlots[0] || !playerSlots[1]) {
      resetGame();
    }
  });
});

// Game control functions
function startGame() {
  isGameActive = true;
  roundNumber = 0;
  io.emit("game_start", {
    players: {
      [playerSlots[0]]: players[playerSlots[0]],
      [playerSlots[1]]: players[playerSlots[1]]
    }
  });
  startTimer();
}

function resetGame() {
  isGameActive = true;
  roundNumber = 0;
  clearInterval(timerInterval);
  playerSlots.forEach((id, index) => {
    if (id) {
      players[id] = { 
        name: `Player ${index + 1}`, 
        units: config.STARTING_UNITS, 
        wager: null 
      };
    }
  });
  io.emit("game_reset");
  startTimer();
}

function startTimer() {
  let timeRemaining = config.TIMER_DURATION;
  io.emit("update_timer", timeRemaining);

  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit("update_timer", timeRemaining);

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      handleTimeout();
    }
  }, 1000);
}

function handleTimeout() {
  const [p1Id, p2Id] = playerSlots;
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  if (p1.wager === null && p2.wager !== null) {
    p1.units -= p2.wager;
    p2.units += p2.wager;
    io.emit("update_game_log", `Player 1 timed out and lost ${p2.wager} units`);
  } else if (p2.wager === null && p1.wager !== null) {
    p2.units -= p1.wager;
    p1.units += p1.wager;
    io.emit("update_game_log", `Player 2 timed out and lost ${p1.wager} units`);
  }

  [p1, p2].forEach(p => p.wager = null);
  checkGameOver();
}

function calculateRoundWinner(p1Id, p2Id) {
  const p1 = players[p1Id];
  const p2 = players[p2Id];
  roundNumber++;

  let winner;
  if (p1.wager === p2.wager) {
    io.emit("round_result", {
      winner: null,
      units: { [p1Id]: p1.units, [p2Id]: p2.units },
      isDraw: true
    });
    io.emit("update_game_log", `Round ${roundNumber}: Draw! Both wagered ${p1.wager}`);
    [p1, p2].forEach(p => p.wager = null);
    startTimer();
    return;
  }

  if (p1.wager > p2.wager * 3) {
    winner = p2;
    p2.units += p1.wager;
    p1.units -= p1.wager;
    io.emit("update_game_log", `Round ${roundNumber}: Player 2 wins via 300% rule!`);
  } else if (p2.wager > p1.wager * 3) {
    winner = p1;
    p1.units += p2.wager;
    p2.units -= p2.wager;
    io.emit("update_game_log", `Round ${roundNumber}: Player 1 wins via 300% rule!`);
  } else if (p1.wager > p2.wager) {
    winner = p1;
    p1.units += p2.wager;
    p2.units -= p2.wager;
    io.emit("update_game_log", `Round ${roundNumber}: Player 1 wins!`);
  } else {
    winner = p2;
    p2.units += p1.wager;
    p1.units -= p1.wager;
    io.emit("update_game_log", `Round ${roundNumber}: Player 2 wins!`);
  }

  io.emit("round_result", {
    winner: winner.name,
    units: { [p1Id]: p1.units, [p2Id]: p2.units },
    isDraw: false
  });

  [p1, p2].forEach(p => p.wager = null);
  checkGameOver();
}

function checkGameOver() {
  const [p1Id, p2Id] = playerSlots;
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  if (p1.units < config.BANKRUPTCY_THRESHOLD || p2.units < config.BANKRUPTCY_THRESHOLD) {
    isGameActive = false;
    const winner = p1.units >= config.BANKRUPTCY_THRESHOLD ? p1Id : p2Id;
    io.emit("game_over", { winnerId: winner });
    clearInterval(timerInterval);
  } else {
    startTimer();
  }
}