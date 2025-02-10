const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files (like index.html) from the current directory
app.use(express.static(__dirname + "/public"));

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
let isGameOver = false; // Track if the game has ended

// Track player readiness for a new game
let playerReady = {};

// Track consecutive double timeouts
let consecutiveDoubleTimeouts = 0;

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
    if (isGameOver) {
      socket.emit("error_message", "The game has ended. Please start a new game.");
      return;
    }

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

    // Notify the opponent that the player has locked in their wager
    const opponentId = playerSlots.find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit("opponent_locked_wager");
    }

    // Check if both players have placed wagers
    const [p1Id, p2Id] = playerSlots;
    if (players[p1Id]?.wager !== null && players[p2Id]?.wager !== null) {
      clearInterval(timerInterval); // Stop the timer
      calculateRoundWinner(p1Id, p2Id);
    }
  });

  // Listen for reset_game event from clients
  socket.on("reset_game", () => {
    console.log("Resetting game...");

    // Mark the player as ready
    playerReady[socket.id] = true;

    // Check if both players are ready
    if (playerReady[playerSlots[0]] && playerReady[playerSlots[1]]) {
      // Reset all players' data
      Object.keys(players).forEach((id) => {
        players[id].units = 200; // Reset units to initial value
        players[id].wager = null; // Clear wagers
      });

      roundNumber = 0; // Reset round number
      isGameOver = false; // Reset game over state
      consecutiveDoubleTimeouts = 0; // Reset double timeout counter
      playerReady = {}; // Reset readiness tracking

      // Notify clients that the game has been reset
      io.emit("game_reset_complete");

      // Start the timer immediately
      startTimer();

      console.log("Game reset successfully!");
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
      delete playerReady[socket.id]; // Remove readiness state
    }

    // Notify other clients and reset game state if necessary
    io.emit("player_left", { id: socket.id });
    console.log(`Slot ${slotIndex + 1} is now available.`);

    if (!playerSlots[0] || !playerSlots[1]) {
      console.log("Game reset due to disconnection.");
      io.emit("game_reset");
      roundNumber = 0; // Reset round number on disconnection
      clearInterval(timerInterval); // Stop the timer
      isGameOver = false; // Reset game over state
      consecutiveDoubleTimeouts = 0; // Reset double timeout counter
    }
  });

  // Function to start the timer
  function startTimer() {
    let timeRemaining = 60; // 60 seconds

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
  
    // Ensure both players are defined
    if (!p1 || !p2) {
      console.log("One or both players are undefined. Skipping timeout handling.");
      return;
    }
  
    let timedOutPlayer = null;
    let winningPlayer = null;
    let lostUnits = 0;
    let logEntry = "";
  
    // Check which player timed out
    if (p1.wager === null && p2.wager !== null) {
      // Player 1 timed out
      timedOutPlayer = p1;
      winningPlayer = p2;
      lostUnits = p2.wager;
      consecutiveDoubleTimeouts = 0; // Reset double timeout counter
    } else if (p2.wager === null && p1.wager !== null) {
      // Player 2 timed out
      timedOutPlayer = p2;
      winningPlayer = p1;
      lostUnits = p1.wager;
      consecutiveDoubleTimeouts = 0; // Reset double timeout counter
    } else if (p1.wager === null && p2.wager === null) {
      // Both players timed out
      consecutiveDoubleTimeouts++;
      if (consecutiveDoubleTimeouts === 1) {
        logEntry = `Double timeout. After 3 consecutive double timeouts in a row, the player with the most units will win the game.`;
      } else if (consecutiveDoubleTimeouts === 2) {
        logEntry = `Double timeout. If the next round is a double timeout, the player with the most units will win the game.`;
      } else if (consecutiveDoubleTimeouts >= 3) {
        if (p1.units > p2.units) {
          io.emit("game_over", { winnerId: p1Id });
          logEntry = `Game Over. You won due to 3 consecutive double timeouts.`;
          io.to(p1Id).emit("update_game_log", logEntry);
          io.to(p2Id).emit("update_game_log", `Game Over. You lost due to 3 consecutive double timeouts.`);
        } else if (p2.units > p1.units) {
          io.emit("game_over", { winnerId: p2Id });
          logEntry = `Game Over. You won due to 3 consecutive double timeouts.`;
          io.to(p2Id).emit("update_game_log", logEntry);
          io.to(p1Id).emit("update_game_log", `Game Over. You lost due to 3 consecutive double timeouts.`);
        } else {
          io.emit("game_over", { winnerId: null });
          logEntry = `Game Over. The game was a draw due to 3 consecutive double timeouts.`;
          io.emit("update_game_log", logEntry);
        }
        isGameOver = true;
        return;
      }
      io.emit("update_game_log", logEntry);
  
      // Emit updated unit counts to both players
      io.emit("round_result", {
        units: { [p1Id]: p1.units, [p2Id]: p2.units },
        isDraw: false,
      });
  
      // Reset wagers for the next round
      p1.wager = null;
      p2.wager = null;
  
      // Start the next round
      startTimer();
      return;
    }
  
    if (timedOutPlayer && winningPlayer) {
      // Deduct and add units
      timedOutPlayer.units -= lostUnits;
      winningPlayer.units += lostUnits;
  
      // Correctly formatted game log message
      logEntry = `${timedOutPlayer.name} timed out and lost ${lostUnits} units to ${winningPlayer.name}.`;
      io.emit("update_game_log", logEntry);
  
      // Emit updated unit counts to both players
      io.emit("round_result", {
        units: { [p1Id]: p1.units, [p2Id]: p2.units },
        isDraw: false,
      });
  
      console.log(logEntry);
    }
  
    // Reset wagers for the next round
    p1.wager = null;
    p2.wager = null;
  
    // Check for end-game conditions
    if (p1.units < 20 || p2.units < 20) {
      const winner = p1.units >= 20 ? p1 : p2;
      io.emit("game_over", { winnerId: winner === p1 ? p1Id : p2Id });
  
      // Stop the timer
      clearInterval(timerInterval);
      io.emit("update_timer", 0);
  
      // Set game over state
      isGameOver = true;
  
      console.log(`Game over! Winner: ${winner.name}`);
    } else {
      // Start the next round
      startTimer();
    }
  }
  
  // Function to calculate round winner with proper zero-sum logic and "400% rule"
  function calculateRoundWinner(player1Id, player2Id) {
    const p1 = players[player1Id];
    const p2 = players[player2Id];
  
    let winner;
  
    // Increment the round number
    roundNumber++;
  
    let logEntry;
    let logNote = "";
  
    // Check for a draw
    if (p1.wager === p2.wager) {
      logEntry = `Round ${roundNumber}: Both players wagered ${p1.wager} units. It's a draw!`;
      io.emit("update_game_log", logEntry);
      io.emit("round_result", {
        units: { [player1Id]: p1.units, [player2Id]: p2.units },
        isDraw: true,
      });
      p1.wager = null;
      p2.wager = null;
  
      // Reset consecutive double timeouts counter
      consecutiveDoubleTimeouts = 0;
  
      // Start the next round
      startTimer();
      return;
    }
  
    // Apply the 400% rule
    if (p1.wager > p2.wager * 4) {
      winner = p2;
      logNote = " due to the '400% rule'";
      p2.units += p1.wager;
      p1.units -= p1.wager;
    } else if (p2.wager > p1.wager * 4) {
      winner = p1;
      logNote = " due to the '400% rule'";
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
  
    // Broadcast game log entry
    logEntry = `Round ${roundNumber}: ${p1.name} wagered ${p1.wager}, ${p2.name} wagered ${p2.wager}. ${winner.name} wins${logNote}!`;
    io.emit("update_game_log", logEntry);
    io.emit("round_result", {
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      isDraw: false,
    });
  
    // Reset wagers
    p1.wager = null;
    p2.wager = null;
  
    // Reset consecutive double timeouts counter
    consecutiveDoubleTimeouts = 0;
  
    // Check for end-game condition
    if (p1.units < 20 || p2.units < 20) {
      const finalWinner = p1.units >= 20 ? p1 : p2;
      io.emit("game_over", { winnerId: finalWinner === p1 ? player1Id : player2Id });
  
      // Stop the timer
      clearInterval(timerInterval);
      io.emit("update_timer", 0);
  
      // Set game over state
      isGameOver = true;
  
      console.log(`Game over! Winner: ${finalWinner.name}`);
      return; // Don't start a new round
    }
  
    // Start the next round
    startTimer();
  }
});