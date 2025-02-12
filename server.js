require("dotenv").config(); // Load environment variables

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Configure CORS to allow connections from Render and localhost
const io = new Server(server, {
  cors: {
    origin: [process.env.CLIENT_URL || "http://localhost:3000", "https://greedy-game.onrender.com"], // Add your Render app URL here
    methods: ["GET", "POST"],
  },
});

// Serve static files
app.use(express.static(__dirname + "/public"));

// Start the server
const PORT = process.env.PORT || 3000; // Use Render's port or default to 3000
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Game state
const playerSlots = [null, null]; // Player 1 -> index 0, Player 2 -> index 1
const players = {}; // Store player data
let roundNumber = 0; // Track the current round number
let timerInterval = null; // Track the timer interval
let isGameOver = false; // Track if the game has ended
let consecutiveDoubleTimeouts = 0; // Track consecutive double timeouts
const playerReady = new Set(); // Track player readiness

// Helper function to reset the game state
function resetGameState() {
  Object.keys(players).forEach((id) => {
    players[id].units = 200;
    players[id].wager = null;
  });
  roundNumber = 0;
  isGameOver = false;
  consecutiveDoubleTimeouts = 0;
  playerReady.clear();
  clearInterval(timerInterval);
  io.emit("game_reset_complete");
}

// Handle Socket.IO connections
io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  // Assign the player to an available slot
  let assignedSlot = null;
  if (!playerSlots[0]) {
    assignedSlot = 0;
    playerSlots[0] = socket.id;
    players[socket.id] = { name: "Player 1", units: 200, wager: null };
    socket.emit("assign_name", { name: "Player 1", id: socket.id });
    console.log("Player 1 has joined the game.");
  } else if (!playerSlots[1]) {
    assignedSlot = 1;
    playerSlots[1] = socket.id;
    players[socket.id] = { name: "Player 2", units: 200, wager: null };
    socket.emit("assign_name", { name: "Player 2", id: socket.id });
    console.log("Player 2 has joined the game.");
  } else {
    socket.emit("error_message", "The game already has two players.");
    socket.disconnect();
    return;
  }

  // Notify all clients about the new player
  io.emit("player_joined", { id: socket.id, name: players[socket.id].name });

  // Start the game if both players are ready
  if (playerSlots[0] && playerSlots[1]) {
    console.log("Two players are ready. Game can start!");
    io.emit("game_ready", {
      players: {
        [playerSlots[0]]: players[playerSlots[0]],
        [playerSlots[1]]: players[playerSlots[1]],
      },
    });
    startTimer();
  }

  // Listen for wagers
  socket.on("place_wager", (wager) => {
    if (isGameOver) {
      socket.emit("error_message", "The game has ended. Please start a new game.");
      return;
    }

    const player = players[socket.id];
    if (!player) {
      socket.emit("error_message", "You are not part of this game.");
      return;
    }

    // Validate wager
    if (wager < 10 || wager > player.units) {
      socket.emit("invalid_wager", `Your wager must be between 10 and ${player.units} units.`);
      return;
    }

    player.wager = wager;
    console.log(`${player.name} placed a wager of ${wager} units.`);

    // Notify the opponent
    const opponentId = playerSlots.find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit("opponent_locked_wager");
    }

    // Check if both players have placed wagers
    const [p1Id, p2Id] = playerSlots;
    if (players[p1Id]?.wager !== null && players[p2Id]?.wager !== null) {
      clearInterval(timerInterval);
      calculateRoundWinner(p1Id, p2Id);
    }
  });

  // Listen for reset_game event
  socket.on("reset_game", () => {
    playerReady.add(socket.id);
    if (playerReady.size === 2) {
      resetGameState();
      startTimer();

      // Emit an event to re-enable wager input fields and buttons
      io.emit("enable_wager_input");
    }
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    console.log(`${players[socket.id]?.name || "A player"} disconnected.`);
    const slotIndex = playerSlots.indexOf(socket.id);
    if (slotIndex !== -1) {
      playerSlots[slotIndex] = null;
      delete players[socket.id];
      playerReady.delete(socket.id);
    }
    io.emit("player_left", { id: socket.id });
    if (!playerSlots[0] || !playerSlots[1]) {
      resetGameState();
    }
  });
});

// Function to start the timer
function startTimer() {
  let timeRemaining = 60;
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

// Function to handle timeout
function handleTimeout() {
  const [p1Id, p2Id] = playerSlots;
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  if (!p1 || !p2) return;

  let timedOutPlayer = null;
  let winningPlayer = null;
  let lostUnits = 0;
  let logEntry = "";

  if (p1.wager === null && p2.wager !== null) {
    // Player 1 timed out
    timedOutPlayer = p1;
    winningPlayer = p2;
    lostUnits = p2.wager;
    consecutiveDoubleTimeouts = 0; // Reset consecutive double timeouts counter
    logEntry = `${p1.name} timed out and lost ${lostUnits} units to ${p2.name}.`;
  } else if (p2.wager === null && p1.wager !== null) {
    // Player 2 timed out
    timedOutPlayer = p2;
    winningPlayer = p1;
    lostUnits = p1.wager;
    consecutiveDoubleTimeouts = 0; // Reset consecutive double timeouts counter
    logEntry = `${p2.name} timed out and lost ${lostUnits} units to ${p1.name}.`;
  } else if (p1.wager === null && p2.wager === null) {
    // Double timeout
    consecutiveDoubleTimeouts++;
    logEntry = `Double timeout. Consecutive double timeouts: ${consecutiveDoubleTimeouts}.`;

    // Check for 3 consecutive double timeouts
    if (consecutiveDoubleTimeouts === 3) {
      if (p1.units > p2.units) {
        handleGameOver(p1Id);
        logEntry += ` Game Over. ${p1.name} wins due to 3 consecutive double timeouts.`;
      } else if (p2.units > p1.units) {
        handleGameOver(p2Id);
        logEntry += ` Game Over. ${p2.name} wins due to 3 consecutive double timeouts.`;
      } else {
        handleGameOver(null);
        logEntry += ` Game Over. It's a draw due to 3 consecutive double timeouts.`;
      }
    }
  }

  io.emit("update_game_log", logEntry);

  if (timedOutPlayer && winningPlayer) {
    timedOutPlayer.units -= lostUnits;
    winningPlayer.units += lostUnits;
    io.emit("round_result", {
      units: { [p1Id]: p1.units, [p2Id]: p2.units },
      isDraw: false,
    });
  }

  p1.wager = null;
  p2.wager = null;

  // Check for end-game condition (units below 20)
  if (p1.units < 20 || p2.units < 20) {
    const winnerId = p1.units >= 20 ? p1Id : p2Id;
    handleGameOver(winnerId);
  } else if (!isGameOver) {
    startTimer();
  }
}

// Function to handle game over
function handleGameOver(winnerId) {
  const p1Id = playerSlots[0];
  const p2Id = playerSlots[1];

  // Determine the end message
  let endMessage = "";
  if (winnerId === p1Id) {
    endMessage = "Congratulations, you won!";
  } else if (winnerId === p2Id) {
    endMessage = "Game over, you lost.";
  } else {
    endMessage = "Game over, it's a draw!";
  }

  // Emit game_over event to all clients
  io.emit("game_over", { winnerId, endMessage });

  // Disable wager input and button
  io.emit("disable_wager_input");

  // Stop the timer
  clearInterval(timerInterval);
  io.emit("update_timer", 0);

  // Set game over state
  isGameOver = true;
}

// Function to calculate round winner
function calculateRoundWinner(player1Id, player2Id) {
  const p1 = players[player1Id];
  const p2 = players[player2Id];
  roundNumber++;

  let logEntry = `Round ${roundNumber}: ${p1.name} wagered ${p1.wager}, ${p2.name} wagered ${p2.wager}. `;

  if (p1.wager === p2.wager) {
    logEntry += `It's a draw!`;
    io.emit("update_game_log", logEntry);
    io.emit("round_result", {
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      isDraw: true,
    });
    p1.wager = null;
    p2.wager = null;
    consecutiveDoubleTimeouts = 0; // Reset consecutive double timeouts counter
    startTimer();
    return;
  }

  let winner;
  let logNote = "";

  if (p1.wager > p2.wager * 4) {
    winner = p2;
    logNote = "due to the '400% rule'";
    p2.units += p1.wager;
    p1.units -= p1.wager;
  } else if (p2.wager > p1.wager * 4) {
    winner = p1;
    logNote = "due to the '400% rule'";
    p1.units += p2.wager;
    p2.units -= p2.wager;
  } else {
    winner = p1.wager > p2.wager ? p1 : p2;
    if (winner === p1) {
      p1.units += p2.wager;
      p2.units -= p2.wager;
    } else {
      p2.units += p1.wager;
      p1.units -= p1.wager;
    }
  }

  logEntry += `${winner.name} wins ${logNote ? logNote : ""}!`;
  io.emit("update_game_log", logEntry);
  io.emit("round_result", {
    units: { [player1Id]: p1.units, [player2Id]: p2.units },
    isDraw: false,
  });

  p1.wager = null;
  p2.wager = null;
  consecutiveDoubleTimeouts = 0; // Reset consecutive double timeouts counter

  // Check for end-game condition (units below 20)
  if (p1.units < 20 || p2.units < 20) {
    const winnerId = p1.units >= 20 ? player1Id : player2Id;
    handleGameOver(winnerId);
  } else {
    startTimer();
  }
}