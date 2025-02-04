const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (like index.html) from the current directory
app.use(express.static(__dirname));

// Start the server
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Track player slots
const playerSlots = [null, null]; // Player 1 -> index 0, Player 2 -> index 1
const players = {}; // Store player data globally
let roundNumber = 0; // Track the current round number
let timerInterval = null; // Track the timer interval

// Handle Socket.IO connections
io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  // Assign the player to an available slot
  let assignedSlot = null;
  if (!playerSlots[0]) {
    assignedSlot = 0; // Assign to Player 1 slot
    playerSlots[0] = socket.id;
    players[socket.id] = { name: "Player 1", units: 200, wager: null };
    socket.emit("assign_name", { name: "Player 1", id: socket.id });
    console.log("Player 1 has joined the game.");
  } else if (!playerSlots[1]) {
    assignedSlot = 1; // Assign to Player 2 slot
    playerSlots[1] = socket.id;
    players[socket.id] = { name: "Player 2", units: 200, wager: null };
    socket.emit("assign_name", { name: "Player 2", id: socket.id });
    console.log("Player 2 has joined the game.");
  } else {
    // Reject additional connections beyond two players
    socket.emit("error_message", "The game already has two players.");
    socket.disconnect();
    return;
  }

  // Notify all clients about the new player
  io.emit("player_joined", { id: socket.id, name: players[socket.id].name });

  // Check if both players are ready
  if (playerSlots[0] && playerSlots[1]) {
    console.log("Two players are ready. Game can start!");
    io.emit("game_ready", {
      players: {
        [playerSlots[0]]: players[playerSlots[0]],
        [playerSlots[1]]: players[playerSlots[1]],
      },
    });

    // Start the timer for the round
    startTimer();
  }

  // Listen for wagers
  socket.on("place_wager", (wager) => {
    const player = players[socket.id];

    if (!player) {
      socket.emit("error_message", "You are not part of this game.");
      return;
    }

    // Validate wager limits (min: 10, max: player's total units)
    if (wager < 10 || wager > player.units) {
      socket.emit(
        "invalid_wager",
        `Your wager must be between 10 and ${player.units} units.`
      );
      return;
    }

    player.wager = wager;
    console.log(`${player.name} placed a wager of ${wager} units.`);

    // Check if both players have placed wagers
    const [p1Id, p2Id] = playerSlots;
    if (players[p1Id]?.wager !== null && players[p2Id]?.wager !== null) {
      clearInterval(timerInterval); // Stop the timer
      calculateRoundWinner(p1Id, p2Id);
    }
  });

  // Handle disconnections
  socket.on("disconnect", () => {
    console.log(`${players[socket.id]?.name || "A player"} disconnected.`);

    // Remove the player from their slot
    const slotIndex = playerSlots.indexOf(socket.id);
    if (slotIndex !== -1) {
      playerSlots[slotIndex] = null;
      delete players[socket.id];
    }

    // Notify other clients and reset game state if necessary
    io.emit("player_left", { id: socket.id });
    console.log(`Slot ${slotIndex + 1} is now available.`);

    if (!playerSlots[0] || !playerSlots[1]) {
      console.log("Game reset due to disconnection.");
      io.emit("game_reset");
      roundNumber = 0; // Reset round number on disconnection
      clearInterval(timerInterval); // Stop the timer
    }
  });

  // Function to start the timer
  function startTimer() {
    let timeRemaining = 30; // 30 seconds

    // Emit the initial timer value to all clients
    io.emit("update_timer", timeRemaining);

    // Start the countdown
    timerInterval = setInterval(() => {
      timeRemaining--;

      // Emit the updated timer value to all clients
      io.emit("update_timer", timeRemaining);

      // Handle timeout
      if (timeRemaining <= 0) {
        clearInterval(timerInterval); // Stop the timer
        handleTimeout();
      }
    }, 1000); // Update every second
  }

  // Function to handle timeout
function handleTimeout() {
  const [p1Id, p2Id] = playerSlots;
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  // Determine which player timed out
  if (p1.wager === null && p2.wager !== null) {
    // Player 1 timed out
    p1.units -= p2.wager;
    p2.units += p2.wager;

    // Log the timeout
    io.emit("update_game_log", `Player 1 timed out and lost ${p2.wager} units to Player 2.`);
  } else if (p2.wager === null && p1.wager !== null) {
    // Player 2 timed out
    p2.units -= p1.wager;
    p1.units += p1.wager;

    // Log the timeout
    io.emit("update_game_log", `Player 2 timed out and lost ${p1.wager} units to Player 1.`);
  }

  // Reset wagers for both players
  p1.wager = null;
  p2.wager = null;

  // Emit round_result to reset the UI for both players
  io.emit("round_result", {
    winner: null, // No winner in a timeout
    units: { [p1Id]: p1.units, [p2Id]: p2.units },
    isDraw: false, // Indicate that this is not a draw
  });

  // Start the next round
  startTimer();
}

  // Function to calculate round winner with proper zero-sum logic and "300% rule"
  function calculateRoundWinner(player1Id, player2Id) {
    const p1 = players[player1Id];
    const p2 = players[player2Id];

    let winner;

    // Increment the round number
    roundNumber++;

    let logEntry;

    if (p1.wager === p2.wager) {
      // Handle draw case
      logEntry = `Round ${roundNumber}: ${p1.name} and ${p2.name} both wagered ${p1.wager} units. It's a draw!`;
      console.log(logEntry);
      io.emit("update_game_log", logEntry);

      // Emit round_result for draw case
      io.emit("round_result", {
        winner: null, // No winner in a draw
        units: { [player1Id]: p1.units, [player2Id]: p2.units },
        isDraw: true, // Indicate that this is a draw
      });

      // Reset wagers for both players after the round ends
      p1.wager = null;
      p2.wager = null;
      return;
    }

    let logNote = "";

    // Apply the 300% rule
    if (p1.wager > p2.wager * 3) {
      winner = p2; // Lower wager wins due to the 300% rule
      logNote = " due to the '300% rule'";
      p2.units += p1.wager;
      p1.units -= p1.wager;
    } else if (p2.wager > p1.wager * 3) {
      winner = p1; // Lower wager wins due to the 300% rule
      logNote = " due to the '300% rule'";
      p1.units += p2.wager;
      p2.units -= p2.wager;
    } else {
      // Standard rule: higher wager wins
      if (p1.wager > p2.wager) {
        winner = p1;
        p1.units += p2.wager;
        p2.units -= p2.wager;
      } else {
        winner = p2;
        p2.units += p1.wager;
        p1.units -= p1.wager;
      }
    }

    logEntry =
      `Round ${roundNumber}: ${p1.name} wagers ${p1.wager} units, ` +
      `${p2.name} wagers ${p2.wager} units. ${winner.name} wins${logNote}!`;

    io.emit("update_game_log", logEntry);

    io.emit("round_result", {
      winner: winner.name,
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      isDraw: false, // Indicate that this is not a draw
    });

    // Reset wagers for both players after the round ends
    p1.wager = null;
    p2.wager = null;

    // Check for end-game conditions
    if (p1.units < 20 || p2.units < 20) {
      const winner = p1.units >= 20 ? p1 : p2; // Determine who has >= 20 units
      io.emit("game_over", { winnerId: winner === p1 ? player1Id : player2Id });
      console.log(`Game over! Winner: ${winner.name}`);
    }

    // Start the next round
    startTimer();
  }

  // Listen for reset_game event from clients
  socket.on("reset_game", () => {
    console.log("Resetting game...");

    // Reset all players' data
    Object.keys(players).forEach((id) => {
      players[id].units = 200; // Reset units to initial value
      players[id].wager = null; // Clear wagers
    });

    roundNumber = 0; // Reset round number

    // Notify clients that the game has been reset
    io.emit("game_reset");

    console.log("Game reset successfully!");
  });
});