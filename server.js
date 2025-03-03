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
  res.sendFile(__dirname + '/public/index.html');
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
  timeRemaining: 60, // Changed to 60 seconds
  gameId: null
};
const playerSessionMap = {}; // Maps session IDs to player IDs

// Debug function to print the current game state
function logGameState() {
  console.log("\n=== GAME STATE ===");
  console.log("Player Slots:", playerSlots);
  console.log("Players:", Object.keys(players).map(id => `${id}: ${players[id].name}, units: ${players[id].units}, wager: ${players[id].wager}`));
  console.log("Session Map:", playerSessionMap);
  console.log("Round:", roundNumber);
  console.log("Game Over:", isGameOver);
  console.log("=================\n");
}

// Call this periodically or after major events
setInterval(logGameState, 10000); // Log every 10 seconds

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

  // Check if this is a returning player
  socket.on("check_session", (sessionId) => {
    console.log(`Player ${socket.id} checking session: ${sessionId}`);
    const playerId = playerSessionMap[sessionId];
    
    if (playerId && players[playerId]) {
      // This is a returning player, reassign their socket
      const slotIndex = playerSlots.indexOf(playerId);
      
      if (slotIndex !== -1) {
        console.log(`Player ${playerId} reconnecting as ${socket.id}, slot: ${slotIndex}`);
        // Remove old socket ID from player slots
        playerSlots[slotIndex] = socket.id;
        
        // Copy player data to new socket ID
        players[socket.id] = players[playerId];
        delete players[playerId];
        
        // Update session mapping
        playerSessionMap[sessionId] = socket.id;
        
        // Send game state to reconnected player
        socket.emit("reconnect_successful", {
          gameId: currentGameId,
          playerId: socket.id,
          units: players[socket.id].units,
          roundNumber: roundNumber
        });
        
        // Notify opponent of reconnection
        const opponentId = playerSlots.find(id => id !== socket.id);
        if (opponentId) {
          io.to(opponentId).emit("opponent_reconnected");
        }
        
        console.log(`Player ${playerId} reconnected as ${socket.id}`);
        logGameState();
        return;
      }
    }
    
    // If we get here, it's a new player or the game state was lost
    console.log(`Assigning new player for session: ${sessionId}`);
    assignNewPlayer(socket, sessionId);
    logGameState();
  });

  function assignNewPlayer(socket, sessionId) {
    // If the sessionId starts with 'player-', use it to determine the player number
    let forcedSlot = null;
    if (sessionId && sessionId.startsWith('player-')) {
      const playerNum = sessionId.split('-')[1];
      if (playerNum === '1' && !playerSlots[0]) {
        forcedSlot = 0;
      } else if (playerNum === '2' && !playerSlots[1]) {
        forcedSlot = 1;
      }
      console.log(`Forced slot assignment: player-${playerNum} → slot ${forcedSlot}`);
    }

    let assignedSlot = null;
    if (forcedSlot === 0 || (!playerSlots[0] && forcedSlot !== 1)) {
      assignedSlot = 0;
      playerSlots[0] = socket.id;
      players[socket.id] = { name: "Player 1", units: 200, wager: null };
      
      // Store session mapping
      if (sessionId) {
        playerSessionMap[sessionId] = socket.id;
      }
      
      socket.emit("assign_name", { id: socket.id });
      console.log("Player 1 has joined the game.");
    } else if (forcedSlot === 1 || (!playerSlots[1] && forcedSlot !== 0)) {
      assignedSlot = 1;
      playerSlots[1] = socket.id;
      players[socket.id] = { name: "Player 2", units: 200, wager: null };
      
      // Store session mapping
      if (sessionId) {
        playerSessionMap[sessionId] = socket.id;
      }
      
      socket.emit("assign_name", { id: socket.id });
      console.log("Player 2 has joined the game.");
    } else {
      socket.emit("error_message", "The game already has two players.");
      socket.disconnect();
      return;
    }

    // Send info about assigned session
    socket.emit("session_assigned", { sessionId: sessionId || generateSessionId() });

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
  }

  // Handle game state request from reconnecting player
  socket.on("request_game_state", () => {
    if (!players[socket.id]) return;
    
    const opponentId = playerSlots.find(id => id !== socket.id && id !== null);
    
    socket.emit("game_state_update", {
      roundNumber: roundNumber + 1,
      units: {
        [socket.id]: players[socket.id].units,
        [opponentId]: opponentId ? players[opponentId].units : 200
      },
      isGameOver: isGameOver,
      canPlaceWager: !isGameOver && players[socket.id].wager === null
    });
  });

  socket.on("place_wager", (wager) => {
    console.log(`Received wager: ${wager} from player ${socket.id}`);
    
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

    const opponentId = playerSlots.find(id => id !== socket.id && id !== null);
    if (opponentId && players[opponentId]) {
      io.to(opponentId).emit("opponent_locked_wager");
    }

    // Log the current player slots and wagers for debugging
    console.log("Current player slots:", playerSlots);
    console.log("Player wagers:", 
      playerSlots[0] ? `Player 1 (${playerSlots[0]}): ${players[playerSlots[0]]?.wager}` : "Player 1: None",
      playerSlots[1] ? `Player 2 (${playerSlots[1]}): ${players[playerSlots[1]]?.wager}` : "Player 2: None"
    );

    const [p1Id, p2Id] = playerSlots;
    
    // Only calculate winner if both players exist and both have placed wagers
    if (p1Id && p2Id && players[p1Id] && players[p2Id] && 
        players[p1Id].wager !== null && players[p2Id].wager !== null) {
      console.log("Both players have wagered, calculating winner...");
      clearInterval(timerInterval);
      calculateRoundWinner(p1Id, p2Id);
    } else {
      // Let the player know we're waiting for an opponent
      if (!opponentId || !players[opponentId]) {
        socket.emit("waiting_message", "Waiting for another player to join...");
      } else if (players[opponentId] && players[opponentId].wager === null) {
        socket.emit("waiting_message", "Waiting for the enemy to place their wager...");
      }
    }
  });

  socket.on("reset_game", () => {
    playerReady.add(socket.id);
    
    const [p1Id, p2Id] = playerSlots;
    const currentPlayer = players[socket.id];
    const otherPlayerId = socket.id === p1Id ? p2Id : p1Id;
    
    // Check if the other player exists
    if (otherPlayerId && players[otherPlayerId]) {
      if (playerReady.size === 1) {
        io.to(socket.id).emit("waiting_message", `Waiting for the enemy to get back in the game`);
        io.to(otherPlayerId).emit("waiting_message", `The enemy is waiting for you to get back in the game`);
      }
    } else {
      socket.emit("waiting_message", "Waiting for another player to join...");
    }

    if (playerReady.size === 2) {
      resetGameState();
    }
  });

  socket.on("disconnect", () => {
    console.log(`${players[socket.id]?.name || "A player"} disconnected.`);
    
    // We don't immediately remove the player to allow for reconnection
    // Instead, we set a timeout to clean up if they don't reconnect
    setTimeout(() => {
      const slotIndex = playerSlots.indexOf(socket.id);
      if (slotIndex !== -1 && playerSlots[slotIndex] === socket.id) {
        playerSlots[slotIndex] = null;
        delete players[socket.id];
        playerReady.delete(socket.id);
        
        // Remove from session map (find key by value)
        Object.keys(playerSessionMap).forEach(sessionId => {
          if (playerSessionMap[sessionId] === socket.id) {
            delete playerSessionMap[sessionId];
          }
        });
        
        if (!playerSlots[0] && !playerSlots[1]) {
          cleanupGame();
        }
      }
    }, 120000); // 2 minutes to reconnect
  });
});

function startTimer() {
  clearInterval(timerInterval);
  
  if (!currentGameId) {
    currentGameId = Date.now().toString();
  }
  
  timerState = {
    isRunning: true,
    timeRemaining: 60, // Changed to 60 seconds
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
  
  // Safety check - make sure both players exist
  if (!p1Id || !p2Id || !players[p1Id] || !players[p2Id]) {
    console.log("Can't handle timeout - one or both players missing");
    // Restart the timer if the game isn't over
    if (!isGameOver) {
      startTimer();
    }
    return;
  }
  
  const p1 = players[p1Id];
  const p2 = players[p2Id];

  roundNumber++;

  let timedOutPlayer = null;
  let winningPlayer = null;
  let lostUnits = 0;
  let logEntryP1 = "";
  let logEntryP2 = "";

  if (p1.wager === null && p2.wager !== null) {
    timedOutPlayer = p1;
    winningPlayer = p2;
    lostUnits = p2.wager;
    consecutiveDoubleTimeouts = 0;
    logEntryP1 = `Round ${roundNumber}: You timed out. Lost ${lostUnits} units.`;
    logEntryP2 = `Round ${roundNumber}: Enemy timed out. You won ${lostUnits} units.`;
  } else if (p2.wager === null && p1.wager !== null) {
    timedOutPlayer = p2;
    winningPlayer = p1;
    lostUnits = p1.wager;
    consecutiveDoubleTimeouts = 0;
    logEntryP1 = `Round ${roundNumber}: Enemy timed out. You won ${lostUnits} units.`;
    logEntryP2 = `Round ${roundNumber}: You timed out. Lost ${lostUnits} units.`;
  } else if (p1.wager === null && p2.wager === null) {
    consecutiveDoubleTimeouts++;
    
    let leadingPlayer = null;
    if (p1.units > p2.units) {
        leadingPlayer = p1;
    } else if (p2.units > p1.units) {
        leadingPlayer = p2;
    }
    
    if (consecutiveDoubleTimeouts === 1) {
        logEntryP1 = `Round ${roundNumber}: Double timeout! Three in a row ends the game. ${leadingPlayer === p1 ? 'You are leading.' : leadingPlayer === p2 ? 'The enemy is leading.' : 'Units even.'}`;
        logEntryP2 = `Round ${roundNumber}: Double timeout! Three in a row ends the game. ${leadingPlayer === p2 ? 'You are leading.' : leadingPlayer === p1 ? 'The enemy is leading.' : 'Units even.'}`;
    } else if (consecutiveDoubleTimeouts === 2) {
        if (p1.units === p2.units) {
            logEntryP1 = logEntryP2 = `Round ${roundNumber}: That's two double timeouts in a row! One more and it's a draw!`;
        } else {
            logEntryP1 = `Round ${roundNumber}: That's two double timeouts in a row! One more and ${leadingPlayer === p1 ? 'you win' : 'the enemy wins'}!`;
            logEntryP2 = `Round ${roundNumber}: That's two double timeouts in a row! One more and ${leadingPlayer === p2 ? 'you win' : 'the enemy wins'}!`;
        }
    } else if (consecutiveDoubleTimeouts === 3) {
        if (p1.units > p2.units) {
            logEntryP1 = `Round ${roundNumber}: Third straight double timeout! You win!`;
            logEntryP2 = `Round ${roundNumber}: Third straight double timeout! The enemy wins!`;
            io.to(p1Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP1,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            io.to(p2Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP2,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            setTimeout(() => {
                handleGameOver(p1Id);
            }, 300);
            return;
        } else if (p2.units > p1.units) {
            logEntryP1 = `Round ${roundNumber}: Third straight double timeout! The enemy wins!`;
            logEntryP2 = `Round ${roundNumber}: Third straight double timeout! You win!`;
            io.to(p1Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP1,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            io.to(p2Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP2,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            setTimeout(() => {
                handleGameOver(p2Id);
            }, 300);
            return;
        } else {
            logEntryP1 = logEntryP2 = `Round ${roundNumber}: Third straight double timeout! It's a draw!`;
            io.to(p1Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP1,
                isDoubleTimeout: true,
                roundNumber: roundNumber,
                isTDT: true
            });
            io.to(p2Id).emit("round_result", {
                units: { [p1Id]: p1.units, [p2Id]: p2.units },
                logEntry: logEntryP2,
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

    io.to(p1Id).emit("round_result", {
        units: { [p1Id]: p1.units, [p2Id]: p2.units },
        logEntry: logEntryP1,
        isDoubleTimeout: true,
        roundNumber: roundNumber,
        specialEvent: {
            p1Wager: 0,
            p2Wager: 0,
            winner: null,
            logNote: "double_timeout"
        }
    });
    io.to(p2Id).emit("round_result", {
        units: { [p1Id]: p1.units, [p2Id]: p2.units },
        logEntry: logEntryP2,
        isDoubleTimeout: true,
        roundNumber: roundNumber,
        specialEvent: {
            p1Wager: 0,
            p2Wager: 0,
            winner: null,
            logNote: "double_timeout"
        }
    });
    
    p1.wager = null;
    p2.wager = null;
    
    if (!isGameOver) {
        startTimer();
    }
    return;
  }

  
  if (timedOutPlayer && winningPlayer) {
    // Calculate how many units the timedOutPlayer can actually lose
    const maxPossibleLoss = timedOutPlayer.units;
    const actualTransfer = Math.min(lostUnits, maxPossibleLoss);
    
    timedOutPlayer.units -= actualTransfer;
    winningPlayer.units += actualTransfer;
    
    // Add a note if the transfer was limited
    let transferNote = "";
    if (actualTransfer < lostUnits) {
      transferNote = ` (limited by available units)`;
      logEntryP1 += transferNote;
      logEntryP2 += transferNote;
    }
    
    // For timeout events, we need to add a special timeout message
    const specialEvent = {
      p1Wager: p1.wager !== null ? p1.wager : 0,
      p2Wager: p2.wager !== null ? p2.wager : 0,
      winner: winningPlayer === p1 ? p1Id : p2Id,
      logNote: "timeout" + (transferNote ? " and" + transferNote : "")
    };
    
    io.to(p1Id).emit("round_result", {
      units: { [p1Id]: p1.units, [p2Id]: p2.units },
      logEntry: logEntryP1,
      isDraw: false,
      roundNumber: roundNumber,
      specialEvent: specialEvent
    });
    io.to(p2Id).emit("round_result", {
      units: { [p1Id]: p1.units, [p2Id]: p2.units },
      logEntry: logEntryP2,
      isDraw: false,
      roundNumber: roundNumber,
      specialEvent: specialEvent
    });
  }

  p1.wager = null;
  p2.wager = null;

  // End the game if either player has 0 units or less than 20 units
  if (p1.units <= 0 || p2.units <= 0 || p1.units < 20 || p2.units < 20) {
    const winnerId = (p1.units <= 0) ? p2Id : (p2.units <= 0) ? p1Id : (p1.units < 20) ? p2Id : p1Id;
    handleGameOver(winnerId);
  } else if (!isGameOver) {
    startTimer();
  }
}

function handleGameOver(winnerId) {
  const p1Id = playerSlots[0];
  const p2Id = playerSlots[1];

  // Safety check - make sure players exist
  if (!p1Id || !p2Id || !players[p1Id] || !players[p2Id]) {
    console.log("Can't handle game over - one or both players missing");
    return;
  }

  clearInterval(timerInterval);
  clearTimeout(gameInactivityTimeout);
  timerState.isRunning = false;
  
  if (winnerId === p1Id) {
    io.to(p1Id).emit("game_over", { endMessage: "Congratulations, you won!" });
    io.to(p2Id).emit("game_over", { endMessage: "You lost." });
  } else if (winnerId === p2Id) {
    io.to(p2Id).emit("game_over", { endMessage: "Congratulations, you won!" });
    io.to(p1Id).emit("game_over", { endMessage: "You lost." });
  } else {
    io.emit("game_over", { endMessage: "Game over, it's a draw!" });
  }

  io.emit("disable_wager_input");
  io.emit("timer_sync", { 
    timeRemaining: 0, 
    gameId: currentGameId,
    isGameOver: true
  });
  isGameOver = true;

  gameInactivityTimeout = setTimeout(() => {
    cleanupGame();
  }, INACTIVITY_TIMEOUT);
}

function calculateRoundWinner(player1Id, player2Id) {
  // Safety check - make sure both players exist
  if (!players[player1Id] || !players[player2Id]) {
    console.log("Can't calculate round winner - one or both players missing");
    return;
  }

  const p1 = players[player1Id];
  const p2 = players[player2Id];
  roundNumber++;

  // Log initial units for debugging
  console.log(`Before calculation - P1: ${p1.units}, P2: ${p2.units}, Total: ${p1.units + p2.units}`);
  console.log(`Wagers - P1: ${p1.wager}, P2: ${p2.wager}`);

  // Changed message format to be shorter
  let p1LogEntry = `Round ${roundNumber}: Your wager: ${p1.wager}, Enemy: ${p2.wager}. `;
  let p2LogEntry = `Round ${roundNumber}: Your wager: ${p2.wager}, Enemy: ${p1.wager}. `;

  if (p1.wager === p2.wager) {
    p1LogEntry += `It's a draw!`;
    p2LogEntry += `It's a draw!`;
    
    // No change in units for a draw
    console.log(`Draw - P1: ${p1.units}, P2: ${p2.units}, Total: ${p1.units + p2.units}`);
    
    io.to(player1Id).emit("round_result", {
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      logEntry: p1LogEntry,
      isDraw: true,
      roundNumber: roundNumber,
      specialEvent: {
        p1Wager: p1.wager,
        p2Wager: p2.wager,
        winner: null,
        logNote: null
      }
    });
    io.to(player2Id).emit("round_result", {
      units: { [player1Id]: p1.units, [player2Id]: p2.units },
      logEntry: p2LogEntry,
      isDraw: true,
      roundNumber: roundNumber,
      specialEvent: {
        p1Wager: p1.wager,
        p2Wager: p2.wager,
        winner: null,
        logNote: null
      }
    });
    p1.wager = null;
    p2.wager = null;
    consecutiveDoubleTimeouts = 0;
    startTimer();
    return;
  }

  let winner;
  let logNote = "";
  let transferAmount = 0;
  let limitedTransfer = false;

  // 400% rule check
  if (p1.wager > p2.wager * 4) {
    winner = p2;
    logNote = "due to the '400% rule'";
    transferAmount = p1.wager; // Amount p1 loses and p2 gains
    
    // Check if player has enough units
    if (transferAmount > p1.units) {
      transferAmount = p1.units;
      limitedTransfer = true;
    }
    
    p1.units -= transferAmount;
    p2.units += transferAmount;
    
    console.log(`400% rule (P1 over) - Transfer: ${transferAmount}`);
  } else if (p2.wager > p1.wager * 4) {
    winner = p1;
    logNote = "due to the '400% rule'";
    transferAmount = p2.wager; // Amount p2 loses and p1 gains
    
    // Check if player has enough units
    if (transferAmount > p2.units) {
      transferAmount = p2.units;
      limitedTransfer = true;
    }
    
    p2.units -= transferAmount;
    p1.units += transferAmount;
    
    console.log(`400% rule (P2 over) - Transfer: ${transferAmount}`);
  } else {
    // Normal win case
    winner = p1.wager > p2.wager ? p1 : p2;
    if (winner === p1) {
      transferAmount = p2.wager;
      
      // Check if player has enough units
      if (transferAmount > p2.units) {
        transferAmount = p2.units;
        limitedTransfer = true;
      }
      
      p1.units += transferAmount;
      p2.units -= transferAmount;
      console.log(`P1 wins - Transfer: ${transferAmount}`);
    } else {
      transferAmount = p1.wager;
      
      // Check if player has enough units
      if (transferAmount > p1.units) {
        transferAmount = p1.units;
        limitedTransfer = true;
      }
      
      p2.units += transferAmount;
      p1.units -= transferAmount;
      console.log(`P2 wins - Transfer: ${transferAmount}`);
    }
  }

  // Add transfer limit note if needed
  if (limitedTransfer) {
    logNote += " (limited by available units)";
  }

  // Log final units for debugging
  console.log(`After calculation - P1: ${p1.units}, P2: ${p2.units}, Total: ${p1.units + p2.units}`);

  if (winner === p1) {
    p1LogEntry += `You win ${logNote ? logNote : ""}!`;
    p2LogEntry += `The enemy wins ${logNote ? logNote : ""}!`;
  } else {
    p1LogEntry += `The enemy wins ${logNote ? logNote : ""}!`;
    p2LogEntry += `You win ${logNote ? logNote : ""}!`;
  }

  io.to(player1Id).emit("round_result", {
    units: { [player1Id]: p1.units, [player2Id]: p2.units },
    logEntry: p1LogEntry,
    isDraw: false,
    roundNumber: roundNumber,
    specialEvent: {
      p1Wager: p1.wager,
      p2Wager: p2.wager,
      winner: winner === p1 ? player1Id : player2Id,
      logNote: logNote
    }
  });
  io.to(player2Id).emit("round_result", {
    units: { [player1Id]: p1.units, [player2Id]: p2.units },
    logEntry: p2LogEntry,
    isDraw: false,
    roundNumber: roundNumber,
    specialEvent: {
      p1Wager: p1.wager,
      p2Wager: p2.wager,
      winner: winner === p1 ? player1Id : player2Id,
      logNote: logNote
    }
  });

  p1.wager = null;
  p2.wager = null;
  consecutiveDoubleTimeouts = 0;

  // End game if a player has 0 units or less than 20
  if (p1.units <= 0 || p2.units <= 0 || p1.units < 20 || p2.units < 20) {
    const winnerId = (p1.units <= 0) ? player2Id : (p2.units <= 0) ? player1Id : (p1.units < 20) ? player2Id : player1Id;
    handleGameOver(winnerId);
  } else {
    startTimer();
  }
}

// Helper function to generate a session ID
function generateSessionId() {
  return Date.now().toString() + Math.random().toString(36).substring(2, 15);
}