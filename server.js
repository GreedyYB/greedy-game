require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [process.env.CLIENT_URL || "http://localhost:3000", "https://greedy-game-2z4z.onrender.com"],
    methods: ["GET", "POST"],
  },
});

app.use(express.static(__dirname + "/public"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

const playerSlots = [null, null];
const players = {};
let roundNumber = 0;
let timerInterval = null;
let isGameOver = false;
let consecutiveDoubleTimeouts = 0;
const playerReady = new Set();
let gameInactivityTimeout = null;
const INACTIVITY_TIMEOUT = 2 * 60 * 1000;
let currentGameId = null;
let timerState = {
  isRunning: false,
  timeRemaining: 20,
  gameId: null
};

function cleanupGame() {
  clearInterval(timerInterval);
  clearTimeout(gameInactivityTimeout);
  timerState = {
    isRunning: false,
    timeRemaining: 0,
    gameId: null
  };
  currentGameId = null;
  isGameOver = true;
  
  io.emit("game_cleanup", {
    message: "Game cleaned up due to inactivity"
  });
}

function resetGameState() {
  clearInterval(timerInterval);
  clearTimeout(gameInactivityTimeout);
  currentGameId = Date.now().toString();
  
  Object.keys(players).forEach((id) => {
    players[id].units = 200;
    players[id].wager = null;
  });
  roundNumber = 0;
  isGameOver = false;
  consecutiveDoubleTimeouts = 0;
  playerReady.clear();
  
  io.emit("game_reset_complete", { 
    gameId: currentGameId,
    timestamp: Date.now()
  });
  startTimer();
  io.emit("enable_wager_input");
}

io.on("connection", (socket) => {
  console.log("A player connected:", socket.id);

  let lastHeartbeat = Date.now();
  
  socket.on("heartbeat", () => {
    lastHeartbeat = Date.now();
  });

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

  io.emit("player_joined", { id: socket.id, name: players[socket.id].name });

  if (playerSlots[0] && playerSlots[1]) {
    console.log("Two players are ready. Game can start!");
    io.emit("game_ready", {
      players: {
        [playerSlots[0]]: players[playerSlots[0]],
        [playerSlots[1]]: players[playerSlots[1]],
      },
    });
    io.emit("update_round", roundNumber + 1);
    startTimer();
  }

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

    if (wager < 10 || wager > player.units) {
      socket.emit("invalid_wager", `Your wager must be between 10 and ${player.units} units.`);
      return;
    }

    player.wager = wager;
    console.log(`${player.name} placed a wager of ${wager} units.`);

    const opponentId = playerSlots.find(id => id !== socket.id);
    if (opponentId) {
      io.to(opponentId).emit("opponent_locked_wager");
    }

    const [p1Id, p2Id] = playerSlots;
    if (players[p1Id]?.wager !== null && players[p2Id]?.wager !== null) {
      clearInterval(timerInterval);
      calculateRoundWinner(p1Id, p2Id);
    }
  });

  socket.on("reset_game", () => {
    playerReady.add(socket.id);
    
    const [p1Id, p2Id] = playerSlots;
    const currentPlayer = players[socket.id];
    const otherPlayerId = socket.id === p1Id ? p2Id : p1Id;
    const otherPlayer = players[otherPlayerId];

    if (playerReady.size === 1) {
      io.to(socket.id).emit("waiting_message", `Waiting for ${otherPlayer.name} to get back in the game`);
      io.to(otherPlayerId).emit("waiting_message", `${currentPlayer.name} is waiting for you to get back in the game`);
    }

    if (playerReady.size === 2) {
      resetGameState();
    }
  });

  socket.on("disconnect", () => {
    console.log(`${players[socket.id]?.name || "A player"} disconnected.`);
    const slotIndex = playerSlots.indexOf(socket.id);
    if (slotIndex !== -1) {
      playerSlots[slotIndex] = null;
      delete players[socket.id];
      playerReady.delete(socket.id);
      
      if (!playerSlots[0] && !playerSlots[1]) {
        cleanupGame();
      }
    }
  });
});

function startTimer() {
  clearInterval(timerInterval);
  
  if (!currentGameId) {
    currentGameId = Date.now().toString();
  }
  
  timerState = {
    isRunning: true,
    timeRemaining: 20,
    gameId: currentGameId
  };
  
  io.emit("timer_sync", {
    timeRemaining: timerState.timeRemaining,
    gameId: timerState.gameId
  });
  
  timerInterval = setInterval(() => {
    if (timerState.timeRemaining > 0) {
      timerState.timeRemaining--;
      io.emit("timer_sync", {
        timeRemaining: timerState.timeRemaining,
        gameId: timerState.gameId
      });
    }
    
    if (timerState.timeRemaining <= 0) {
      clearInterval(timerInterval);
      timerState.isRunning = false;
      handleTimeout();
    }
  }, 1000);
}

function handleTimeout() {
  const [p1Id, p2Id] = playerSlots;
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  if (!p1 || !p2) return;

  roundNumber++;

  let timedOutPlayer = null;
  let winningPlayer = null;
  let lostUnits = 0;
  let logEntry = "";

  if (p1.wager === null && p2.wager !== null) {
    timedOutPlayer = p1;
    winningPlayer = p2;
    lostUnits = p2.wager;
    consecutiveDoubleTimeouts = 0;
    logEntry = `Round ${roundNumber}: ${p1.name} timed out and lost ${lostUnits} units to ${p2.name}.`;
  } else if (p2.wager === null && p1.wager !== null) {
    timedOutPlayer = p2;
    winningPlayer = p1;
    lostUnits = p1.wager;
    consecutiveDoubleTimeouts = 0;
    logEntry = `Round ${roundNumber}: ${p2.name} timed out and lost ${lostUnits} units to ${p1.name}.`;
  } else if (p1.wager === null && p2.wager === null) {
    consecutiveDoubleTimeouts++;
    
    let leadingPlayer = null;
    if (p1.units > p2.units) {
        leadingPlayer = p1;
    } else if (p2.units > p1.units) {
        leadingPlayer = p2;
    }
    
    if (consecutiveDoubleTimeouts === 1) {
        logEntry = `Round ${roundNumber}: Double timeout! Three in a row ends the game. ${leadingPlayer ? `${leadingPlayer.name} is leading` : 'Units even'}`;
    } else if (consecutiveDoubleTimeouts === 2) {
        if (p1.units === p2.units) {
            logEntry = `Round ${roundNumber}: That's two double timeouts in a row! One more and it's a draw!`;
        } else {
            logEntry = `Round ${roundNumber}: That's two double timeouts in a row! One more and ${leadingPlayer.name} wins!`;
        }
    } else if (consecutiveDoubleTimeouts === 3) {
        if (p1.units > p2.units) {
            logEntry = `Round ${roundNumber}: Third straight double timeout! ${p1.name} is the winner!`;
            io.emit("update_game_log", logEntry);
            io.emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            setTimeout(() => {
                handleGameOver(p1Id);
            }, 300);
            return;
        } else if (p2.units > p1.units) {
            logEntry = `Round ${roundNumber}: Third straight double timeout! ${p2.name} is the winner!`;
            io.emit("update_game_log", logEntry);
            io.emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            setTimeout(() => {
                handleGameOver(p2Id);
            }, 300);
            return;
        } else {
            logEntry = `Round ${roundNumber}: Third straight double timeout! It's a draw!`;
            io.emit("update_game_log", logEntry);
            io.emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            setTimeout(() => {
                handleGameOver(null);
            }, 300);
            return;
        }
    }

    io.emit("round_result", {
      units: { [p1Id]: p1.units, [p2Id]: p2.units },
      logEntry,
      isDoubleTimeout: true,
      roundNumber: roundNumber
  });
  
  p1.wager = null;
  p2.wager = null;
  
  if (!isGameOver) {
      startTimer();
  }
  return;
}

io.emit("update_game_log", logEntry);

if (timedOutPlayer && winningPlayer) {
  timedOutPlayer.units -= lostUnits;
  winningPlayer.units += lostUnits;
  io.emit("round_result", {
    units: { [p1Id]: p1.units, [p2Id]: p2.units },
    logEntry,
    isDraw: false,
    roundNumber: roundNumber
  });
}

p1.wager = null;
p2.wager = null;

if (p1.units < 20 || p2.units < 20) {
  const winnerId = p1.units >= 20 ? p1Id : p2Id;
  handleGameOver(winnerId);
} else if (!isGameOver) {
  startTimer();
}
}

function handleGameOver(winnerId) {
  const p1Id = playerSlots[0];
  const p2Id = playerSlots[1];

  clearInterval(timerInterval);
  clearTimeout(gameInactivityTimeout);
  timerState.isRunning = false;
  
  let endMessage = "";
  if (winnerId === p1Id) {
    io.to(p1Id).emit("game_over", { endMessage: "Congratulations, you won!" });
    io.to(p2Id).emit("game_over", { endMessage: "Game over, you lost." });
  } else if (winnerId === p2Id) {
    io.to(p2Id).emit("game_over", { endMessage: "Congratulations, you won!" });
    io.to(p1Id).emit("game_over", { endMessage: "Game over, you lost." });
  } else {
    io.emit("game_over", { endMessage: "Game over, it's a draw!" });
  }

  io.emit("disable_wager_input");
  io.emit("timer_sync", { 
    timeRemaining: 0, 
    gameId: currentGameId,
    isGameOver: true,
    forceRed: true  // Add this flag
  });
  isGameOver = true;

  gameInactivityTimeout = setTimeout(() => {
    cleanupGame();
  }, INACTIVITY_TIMEOUT);
}

function calculateRoundWinner(player1Id, player2Id) {
  const p1 = players[player1Id];
  const p2 = players[player2Id];
  roundNumber++;

  let logEntry = `Round ${roundNumber}: ${p1.name} wagered ${p1.wager}, ${p2.name} wagered ${p2.wager}. `;

  if (p1.wager === p2.wager) {
    logEntry += `It's a draw!`;
    io.emit("round_result", {
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      logEntry,
      isDraw: true,
      roundNumber: roundNumber
    });
    p1.wager = null;
    p2.wager = null;
    consecutiveDoubleTimeouts = 0;
    
    // Reset timer after processing wagers
    clearInterval(timerInterval);
    timerState.timeRemaining = 20;
    io.emit("timer_sync", { 
      timeRemaining: 20, 
      gameId: currentGameId,
      forceReset: true
    });
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
  io.emit("round_result", {
    units: { [player1Id]: p1.units, [player2Id]: p2.units },
    logEntry,
    isDraw: false,
    roundNumber: roundNumber
  });

  p1.wager = null;
  p2.wager = null;
  consecutiveDoubleTimeouts = 0;

  if (p1.units < 20 || p2.units < 20) {
    const winnerId = p1.units >= 20 ? player1Id : player2Id;
    handleGameOver(winnerId);
  } else {
    // Reset timer after processing wagers
    clearInterval(timerInterval);
    timerState.timeRemaining = 20;
    io.emit("timer_sync", { 
      timeRemaining: 20, 
      gameId: currentGameId,
      forceReset: true
    });
    startTimer();
  }
}