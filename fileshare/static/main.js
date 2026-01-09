let sessionUid = null, socket = null, reconnectTimer = null, heartbeatTimer = null;
let myUserId = null;
let CHUNK_SIZE = 1024 * 255; 
const MEASURE_INTERVAL = 1000, MEASURE_WINDOW = 1500;
const WEBRTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }] };

let incomingFiles = {}, outgoingFiles = {}, currentUploadXHR = null, pendingOffer = null;
let visibilityMode = 'private', currentTransferMode = 'p2p';
let peerConnections = {}, dataChannels = {}, activeRefills = {};
let transferMetrics = { history: [], throughput: 0, speedUnit: 'bits' };

let e2eeEnabled = false;
let e2eeSession = { active: false, key: null, fingerprint: null, peerFingerprint: null };

function connect() {
  if (socket) {
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    socket.close();
  }
  const uidParam = sessionUid ? `&uid=${sessionUid}` : "";
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    startHeartbeat();
    socket.send(JSON.stringify({ type: "update_mode", mode: currentTransferMode }));
    socket.send(JSON.stringify({ type: "update_visibility", visibility: visibilityMode }));
  };
  socket.onclose = (e) => {
    stopHeartbeat();
    renderOnlineUsers([]); 
    if (!reconnectTimer) reconnectTimer = setInterval(connect, 3000);
  };
  socket.onerror = (err) => { socket.close(); };
  socket.onmessage = handleSocketMessage;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

connect();

class E2EEManager {
  static async generateKeyPair() {
    return await window.crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"]);
  }
  static async exportKey(key) {
    const exported = await window.crypto.subtle.exportKey("raw", key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }
  static async importKey(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return await window.crypto.subtle.importKey("raw", bytes, { name: "ECDH", namedCurve: "P-256" }, true, []);
  }
  static async deriveKey(myPrivate, peerPublic) {
    const sharedSecret = await window.crypto.subtle.deriveBits({ name: "ECDH", public: peerPublic }, myPrivate, 256);
    const hash = await window.crypto.subtle.digest("SHA-256", sharedSecret);
    const fingerprint = Array.from(new Uint8Array(hash).slice(0, 8)).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('-');
    const aesKey = await window.crypto.subtle.deriveKey({ name: "ECDH", public: peerPublic }, myPrivate, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { aesKey, fingerprint };
  }
  static async encryptChunk(key, data) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, data);
    const combined = new Uint8Array(12 + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), 12);
    return combined.buffer;
  }
  static async decryptChunk(key, combined) {
    let buf = combined.buffer || combined;
    if (typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer) buf = buf.slice(0);
    const offset = combined.byteOffset || 0;
    const iv = new Uint8Array(buf, offset, 12);
    const data = new Uint8Array(buf, offset + 12, combined.byteLength - 12);
    return await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, data);
  }
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024, sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + " " + sizes[i];
}

function formatSpeed(bytesPerSec, decimals = 2) {
  if (bytesPerSec === 0) return transferMetrics.speedUnit === 'bits' ? "0 Mbps" : "0 B/s";
  if (transferMetrics.speedUnit === 'bits') {
    const bitsPerSec = bytesPerSec * 8;
    const k = 1000, sizes = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
    const i = bitsPerSec > 0 ? Math.floor(Math.log(bitsPerSec) / Math.log(k)) : 0;
    return parseFloat((i < 0 ? bitsPerSec : (bitsPerSec / Math.pow(k, i))).toFixed(decimals)) + " " + (sizes[i] || "bps");
  }
  return formatBytes(bytesPerSec, decimals) + "/s";
}

async function handleSocketMessage(e) {
  try {
    if (typeof e.data !== "string") return;
    let payload = JSON.parse(e.data);
    const senderId = payload.sender_id || payload.target_user_id;

    if (payload.type === "user_id") {
      myUserId = payload.user_id;
      sessionUid = myUserId;
      if (document.getElementById("myUserId")) document.getElementById("myUserId").innerHTML = myUserId;
      updateInviteLink();
    } else if (payload.type === "users") {
      renderOnlineUsers(payload.users || []);
    } else if (payload.type.startsWith("webrtc_") || ["file_offer", "file_response", "file_cancel", "e2ee_fingerprint"].includes(payload.type)) {
      await handleP2PSignal(senderId, payload);
    }
  } catch (err) { console.warn(err); }
}

async function handleP2PSignal(senderId, payload) {
  const type = payload.type;

  if (type === "file_offer") {
    if (currentTransferMode === 'upload') {
      socket.send(JSON.stringify({ type: "file_response", target_user_id: senderId, file_id: payload.file_id, status: "rejected" }));
      return;
    }
    const { file_name, file_size, file_id, e2ee_on, pubkey } = payload;
    if (e2ee_on && !e2eeEnabled) {
      alert(`⚠️ ${senderId} sent encrypted file, but you have E2EE disabled. REJECTED.`);
      socket.send(JSON.stringify({ type: "file_response", target_user_id: senderId, file_id: file_id, status: "rejected", reason: "Receiver E2EE is disabled, can't send encypted file." }));
      return; 
    }
    if (!e2ee_on && e2eeEnabled) {
      alert(`⚠️ You have E2EE enabled, but ${senderId} sent unencrypted file. REJECTED.`);
      socket.send(JSON.stringify({ type: "file_response", target_user_id: senderId, file_id: file_id, status: "rejected", reason: "Receiver E2EE is enabled, can't send unencrypted file." }));
      return;
    }

    pendingOffer = { senderId, payload };
    if (document.getElementById("incomingFileName")) document.getElementById("incomingFileName").textContent = file_name;
    if (document.getElementById("incomingFileInfo")) document.getElementById("incomingFileInfo").textContent = `Size: ${formatBytes(file_size)} • From: ${senderId}`;
    document.getElementById("incomingRequest")?.classList.remove("d-none");
    
    const acceptBtn = document.getElementById("acceptBtn");
    if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = "Accept"; }
    await initWebRTC(senderId);
  } else if (type === "file_response") {
    const t = outgoingFiles[payload.file_id];
    if (!t) return;
    if (t.confirmTimeout) { clearTimeout(t.confirmTimeout); delete t.confirmTimeout; }
    
    if (payload.status === "accepted") {
      if (e2eeEnabled && payload.pubkey) await setupE2EESession(senderId, payload.pubkey);
      const dc = dataChannels[senderId];
      if (dc && dc.readyState === "open") startSendingFile(payload.file_id);
      else {
        t.waitingForWebRTC = true;
        await initWebRTC(senderId, true);
      }
    } else {
      const reason = payload.reason ? ` - ${payload.reason}` : "";
      alert(`⚠️ Rejected by ${senderId}${reason}`);
      resetTransferState(payload.file_id, true);
    }
  } else if (type === "e2ee_fingerprint") {
    e2eeSession.peerFingerprint = payload.fingerprint;
    updateE2EEUI();
  } else if (type === "webrtc_offer") {
    await handleWebRTCOffer(senderId, payload.offer);
  } else if (type === "webrtc_answer") {
    await handleWebRTCAnswer(senderId, payload.answer);
  } else if (type === "webrtc_ice") {
    handleWebRTCIce(senderId, payload.candidate);
  } else if (type === "file_cancel") {
    if (pendingOffer && pendingOffer.payload.file_id === payload.file_id) {
      document.getElementById("incomingRequest")?.classList.add("d-none");
      pendingOffer = null;
      return; 
    }
    if (!payload.reason || !payload.reason.includes("DataChannel")) alert(`Cancelled by other user`);
    if (incomingFiles[payload.file_id]) resetTransferState(payload.file_id, false);
    else if (outgoingFiles[payload.file_id]) resetTransferState(payload.file_id, true);
  } else if (type === "file_ack") {
    const t = outgoingFiles[payload.file_id];
    if (t && !t.cancelled) {
      const delta = payload.received - t.offset;
      if (delta > 0) updateMetrics(delta);
      t.offset = payload.received;
      updateProgress(t.offset, t.file.size);
      if (t.offset >= t.file.size) completeTransfer(payload.file_id);
    }
  }
}

async function initWebRTC(targetId, isOfferer = false) {
  let pc = peerConnections[targetId];
  if (pc && (pc.signalingState === "closed" || pc.connectionState === "closed" || pc.connectionState === "failed")) {
    pc = null; delete peerConnections[targetId]; delete dataChannels[targetId];
  }

  if (!pc) {
    pc = new RTCPeerConnection(WEBRTC_CONFIG);
    peerConnections[targetId] = pc;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        for (let id in outgoingFiles) if (outgoingFiles[id].targetId === targetId) cancelTransfer(id, targetId, true, "PC Connection Failed");
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "webrtc_ice", target_user_id: targetId, candidate: e.candidate }));
    };
    pc.ondatachannel = (e) => setupDataChannel(targetId, e.channel);
  }

  if (isOfferer && (!dataChannels[targetId] || dataChannels[targetId].readyState !== "open")) {
    const dc = pc.createDataChannel("fileTransfer", { ordered: false, priority: "high" });
    setupDataChannel(targetId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "webrtc_offer", target_user_id: targetId, offer: offer }));
  }
}

function setupDataChannel(targetId, dc) {
  dataChannels[targetId] = dc;
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 8 * 1024 * 1024; 
  
  dc.onopen = () => {
    setTimeout(() => {
      for (let i = 0; i < 12; i++) refillBuffer(targetId); 
      for (let fileId in outgoingFiles) {
        const t = outgoingFiles[fileId];
        if (t.targetId === targetId && t.startTime === 0 && t.waitingForWebRTC) {
          delete t.waitingForWebRTC;
          startSendingFile(fileId);
        }
      }
    }, 10);
  };
  dc.onbufferedamountlow = () => { for (let i = 0; i < 6; i++) refillBuffer(targetId); };
  dc.onclose = () => {
    delete dataChannels[targetId];
    for (let id in outgoingFiles) if (outgoingFiles[id].targetId === targetId) cancelTransfer(id, targetId, true, "DataChannel Closed");
    for (let id in incomingFiles) if (incomingFiles[id].senderId === targetId) cancelTransfer(id, targetId, false, "DataChannel Closed");
  };
  dc.onmessage = async (e) => {
    if (typeof e.data === "string") {
      try { await handleP2PSignal(targetId, JSON.parse(e.data)); } catch (err) {}
    } else handleBinaryChunk(e.data);
  };
}

async function refillBuffer(targetId) {
  const active = activeRefills[targetId] || 0;
  if (active >= 12) return; 
  const dc = dataChannels[targetId];
  if (!dc || dc.readyState !== "open") return;

  activeRefills[targetId] = active + 1;
  try {
    for (let fileId in outgoingFiles) {
      const t = outgoingFiles[fileId];
      if (t.targetId === targetId && !t.cancelled && t.startTime > 0) {
        while (dc.readyState === "open" && dc.bufferedAmount < 12 * 1024 * 1024) {
          if (!(await readNextChunk(fileId))) break;
        }
      }
    }
  } finally { activeRefills[targetId]--; }
}

async function handleWebRTCOffer(senderId, offer) {
  await initWebRTC(senderId);
  const pc = peerConnections[senderId];
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.send(JSON.stringify({ type: "webrtc_answer", target_user_id: senderId, answer: answer }));
}

async function handleWebRTCAnswer(senderId, answer) {
  if (peerConnections[senderId]) await peerConnections[senderId].setRemoteDescription(new RTCSessionDescription(answer));
}

function handleWebRTCIce(senderId, candidate) {
  if (peerConnections[senderId]) peerConnections[senderId].addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
}

function updateMetrics(bytes) {
  transferMetrics.history.push({ time: Date.now(), bytes: bytes });
}

function calculateThroughput() {
  const now = Date.now(), history = transferMetrics.history;
  transferMetrics.history = history.filter(h => h.time > (now - MEASURE_WINDOW));
  const updatedHistory = transferMetrics.history;
  
  if (!updatedHistory.length) {
    transferMetrics.throughput = 0;
    return;
  }
  
  const totalBytes = updatedHistory.reduce((s, h) => s + h.bytes, 0);
  const timeSpan = Math.max((now - updatedHistory[0].time) / 1000, 0.1);
  transferMetrics.throughput = totalBytes / timeSpan;
}

setInterval(() => {
  const isActive = Object.keys(outgoingFiles).length || Object.keys(incomingFiles).length || currentUploadXHR;
  if (isActive) {
    calculateThroughput();
    for (let fileId in outgoingFiles) {
      const t = outgoingFiles[fileId];
      if (!t.cancelled && t.startTime > 0) {
        const dc = dataChannels[t.targetId];
        if (dc && dc.readyState === "open" && dc.bufferedAmount < 1024 * 1024) {
          refillBuffer(t.targetId);
        }
      }
    }

    const speedEl = document.getElementById("transferSpeed");
    if (speedEl) speedEl.textContent = formatSpeed(transferMetrics.throughput);
  } else {
    transferMetrics.throughput = 0; transferMetrics.history = [];
  }
}, MEASURE_INTERVAL);

function handleBinaryChunk(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const type = view.getUint8(0);
  
  if (type === 67) { 
    const fileId = view.getBigUint64(1).toString(), offset = Number(view.getBigUint64(9)), timestamp = Number(view.getBigUint64(17));
    let data = new Uint8Array(arrayBuffer, 25);
    
    if (e2eeSession.active && e2eeSession.key) {
      E2EEManager.decryptChunk(e2eeSession.key, data).then(decrypted => processChunk(fileId, offset, timestamp, decrypted))
        .catch(err => { cancelTransfer(fileId, incomingFiles[fileId]?.senderId, false, "Decryption Failure"); });
    } else processChunk(fileId, offset, timestamp, data);
  } else if (type === 65) {
    const fileId = view.getBigUint64(1).toString(), received = Number(view.getBigUint64(9));
    const t = outgoingFiles[fileId];
    if (t && !t.cancelled) {
       const delta = received - t.offset;
       if (delta > 0) updateMetrics(delta);
       t.offset = received;
       updateProgress(t.offset, t.file.size);
       if (t.offset >= t.file.size) completeTransfer(fileId);
    }
  }
}

function processChunk(fileId, offset, timestamp, data) {
  const t = incomingFiles[fileId];
  if (!t) return;
  if (t.receivedSize === 0) {
    document.getElementById("progressLabelMini").textContent = t.name;
    document.getElementById("progressLabel").textContent = t.name;
    document.getElementById("detailedStatus").textContent = "Receiving";
    document.getElementById("directionIndicator").className = "bi bi-arrow-down-circle-fill text-success small";
    showProgressBar();
    updateE2EEUI();
  }

  const chunkIndex = Math.floor(offset / CHUNK_SIZE);
  if (!t.receivedChunks) t.receivedChunks = {};
  if (!t.receivedChunks[chunkIndex]) {
    t.receivedChunks[chunkIndex] = data;
    t.receivedSize += data.byteLength || data.size;
    updateMetrics(data.byteLength || data.size); 
    updateProgress(t.receivedSize, t.size);
  }

  const dc = dataChannels[t.senderId];
  if (dc && dc.readyState === "open") {
    const ackFrame = new Uint8Array(17);
    const ackView = new DataView(ackFrame.buffer);
    ackFrame[0] = 65; 
    ackView.setBigUint64(1, BigInt(fileId));
    ackView.setBigUint64(9, BigInt(t.receivedSize));
    dc.send(ackFrame.buffer);
  }

  if (t.receivedSize >= t.size) {
    t.chunks = [];
    const numChunks = Math.ceil(t.size / CHUNK_SIZE);
    for (let i = 0; i < numChunks; i++) if (t.receivedChunks[i]) t.chunks.push(t.receivedChunks[i]);
    setTimeout(() => saveReceivedFile(fileId), 100);
  }
}

document.getElementById("acceptBtn")?.addEventListener("click", async (e) => {
  if (!pendingOffer) return;
  const btn = e.target;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    const { senderId, payload } = pendingOffer;
    incomingFiles[payload.file_id] = { name: payload.file_name, size: payload.file_size, type: payload.file_type, chunks: [], receivedSize: 0, startTime: Date.now(), senderId };
    transferMetrics.history = []; transferMetrics.throughput = 0;
    
    document.getElementById("detailedStatus").textContent = "Receiving";
    document.getElementById("directionIndicator").className = "bi bi-arrow-down-circle-fill text-success small";
    
    const response = { type: "file_response", target_user_id: senderId, file_id: payload.file_id, status: "accepted" };

    if (e2eeEnabled) {
      if (!window.crypto.subtle) throw new Error("Web Crypto API not available");
      const keys = await E2EEManager.generateKeyPair();
      response.pubkey = await E2EEManager.exportKey(keys.publicKey);
      if (payload.pubkey) {
        const peerPub = await E2EEManager.importKey(payload.pubkey);
        const { aesKey, fingerprint } = await E2EEManager.deriveKey(keys.privateKey, peerPub);
        e2eeSession = { active: true, key: aesKey, fingerprint, peerFingerprint: null };
        socket.send(JSON.stringify({ type: "e2ee_fingerprint", target_user_id: senderId, fingerprint: fingerprint }));
        updateE2EEUI();
      }
    }
    socket.send(JSON.stringify(response));
    document.getElementById("incomingRequest")?.classList.add("d-none");
    pendingOffer = null;
  } catch (err) {
    console.error("Accept failed:", err);
    alert("Error accepting file: " + err.message);
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

document.getElementById("rejectBtn")?.addEventListener("click", () => {
  if (!pendingOffer) return;
  socket.send(JSON.stringify({ type: "file_response", target_user_id: pendingOffer.senderId, file_id: pendingOffer.payload.file_id, status: "rejected" }));
  document.getElementById("incomingRequest")?.classList.add("d-none");
  pendingOffer = null;
});

document.getElementById("cancelBtn")?.addEventListener("click", () => {
  for (let id in outgoingFiles) cancelTransfer(id, outgoingFiles[id].targetId, true, "User clicked cancel");
  for (let id in incomingFiles) cancelTransfer(id, incomingFiles[id].senderId, false, "User clicked cancel");
  if (currentUploadXHR) {
    currentUploadXHR.abort(); currentUploadXHR = null;
    resetProgress();
    const btn = document.getElementById("primaryActionBtn");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-cloud-arrow-up-fill me-2"></i>Upload & Share';
      btn.classList.replace("btn-success", "btn-primary");
    }
  }
});

function cancelTransfer(fileId, targetId, isSender, reason = "Unknown") {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "file_cancel", target_user_id: targetId, file_id: fileId, reason: reason }));
  resetTransferState(fileId, isSender);
}

function resetTransferState(fileId, isSender) {
  if (isSender) {
    if (outgoingFiles[fileId]) {
      if (outgoingFiles[fileId].confirmTimeout) clearTimeout(outgoingFiles[fileId].confirmTimeout);
      outgoingFiles[fileId].cancelled = true;
      delete outgoingFiles[fileId];
    }
    const btn = document.querySelector(".send-btn");
    if (btn) { btn.disabled = false; btn.textContent = "Send File"; btn.classList.remove("btn-success"); }
    document.getElementById("form")?.reset();
    if (document.getElementById("fileNameDisplay")) document.getElementById("fileNameDisplay").textContent = "No file selected";
  } else {
    delete incomingFiles[fileId];
    if (pendingOffer && pendingOffer.payload.file_id === fileId) { document.getElementById("incomingRequest")?.classList.add("d-none"); pendingOffer = null; }
  }
  resetProgress();
  e2eeSession = { active: false, key: null, fingerprint: null, peerFingerprint: null }; updateE2EEUI();
  const acceptBtn = document.getElementById("acceptBtn");
  if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = "Accept"; }
}

document.getElementById("form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentTransferMode === 'upload') { await handleFileUpload(); return; }

  let file = document.getElementById("fileInput").files[0];
  let target = document.getElementById("userInput").value;
  if (!file || !target) return;
  const fileId = Date.now().toString();
  outgoingFiles[fileId] = { file, targetId: target, offset: 0, startTime: 0, cancelled: false, chunksSent: 0 };
  transferMetrics.history = []; transferMetrics.throughput = 0;
  
  const btn = document.querySelector(".send-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Waiting for confirm..."; }

  if (socket.readyState === WebSocket.OPEN) {
    const offer = { type: "file_offer", target_user_id: target, file_name: file.name, file_size: file.size, file_type: file.type, file_id: fileId, e2ee_on: e2eeEnabled };
    if (e2eeEnabled) {
      if (!window.crypto.subtle) { alert("Web Crypto API unavailable"); if (btn) btn.disabled = false; return; }
      const keys = await E2EEManager.generateKeyPair();
      offer.pubkey = await E2EEManager.exportKey(keys.publicKey);
      window._pendingKeys = window._pendingKeys || {};
      window._pendingKeys[target] = keys.privateKey;
    }
    socket.send(JSON.stringify(offer));
    outgoingFiles[fileId].confirmTimeout = setTimeout(() => {
      if (outgoingFiles[fileId] && !outgoingFiles[fileId].startTime) {
        alert("Recipient did not respond in time.");
        cancelTransfer(fileId, target, true, "Response Timeout");
      }
    }, 30000);
  } else alert("Not connected to server.");
});

function startSendingFile(fileId) {
  const t = outgoingFiles[fileId];
  if (!t) return;
  t.startTime = Date.now();
  const btn = document.querySelector(".send-btn");
  if (btn) btn.textContent = "Sending...";
  
  document.getElementById("progressLabelMini").textContent = t.file.name;
  document.getElementById("progressLabel").textContent = t.file.name;
  document.getElementById("detailedStatus").textContent = "Sending";
  document.getElementById("directionIndicator").className = "bi bi-arrow-up-circle-fill text-primary small";
  
  showProgressBar();
  updateE2EEUI();
  updateProgress(0, t.file.size);
  for (let i = 0; i < 12; i++) refillBuffer(t.targetId);
}

async function setupE2EESession(peerId, peerPubKeyB64) {
  if (!e2eeEnabled || !window._pendingKeys?.[peerId]) return;
  try {
    const peerPub = await E2EEManager.importKey(peerPubKeyB64);
    const { aesKey, fingerprint } = await E2EEManager.deriveKey(window._pendingKeys[peerId], peerPub);
    e2eeSession = { active: true, key: aesKey, fingerprint, peerFingerprint: null };
    delete window._pendingKeys[peerId];
    updateE2EEUI();
  } catch (err) { console.error("E2EE Fail", err); }
}

function updateE2EEUI() {
  const display = document.getElementById("e2eeKeyDisplay");
  const fingerprintEl = document.getElementById("e2eeFingerprintMini");
  const popover = display?.querySelector(".e2ee-popover");
  const isE2EEActive = (e2eeSession.active && e2eeSession.key) || (currentTransferMode === 'upload' && e2eeEnabled && currentUploadXHR);
  
  if (isE2EEActive && display && fingerprintEl) {
    if (currentTransferMode === 'upload') {
      fingerprintEl.textContent = "Fernet AES-128";
      if(popover) { popover.querySelector(".fw-bold").textContent = 'Stored Encrypted'; popover.querySelector(".smaller").textContent = "Secure on server"; }
    } else {
      if (fingerprintEl.textContent !== e2eeSession.fingerprint) fingerprintEl.textContent = e2eeSession.fingerprint;
      if(popover) {
        const header = popover.querySelector(".fw-bold");
        if (e2eeSession.peerFingerprint === e2eeSession.fingerprint) { header.textContent = 'Verified'; header.className = "smaller fw-bold text-success"; }
        else { header.textContent = 'Secured'; header.className = "smaller fw-bold text-primary"; }
        popover.querySelector(".smaller.opacity-75").textContent = "End-to-End Encrypted";
      }
    }
    display.classList.remove("d-none"); display.classList.add("d-flex");
  } else if (display) { display.classList.add("d-none"); display.classList.remove("d-flex"); }
}

document.addEventListener("click", (e) => {
  const shieldBtn = e.target.closest(".e2ee-shield-btn");
  if (shieldBtn) {
    const popover = shieldBtn.nextElementSibling;
    if (popover) { popover.classList.toggle("visible"); e.stopPropagation(); }
  } else document.querySelectorAll(".e2ee-popover").forEach(p => p.classList.remove("visible"));
});

async function readNextChunk(fileId) {
  const t = outgoingFiles[fileId];
  if (!t || t.cancelled) return false;
  const offset = t.chunksSent * CHUNK_SIZE;
  if (offset >= t.file.size) return false;
  t.chunksSent++;

  try {
    const body = await t.file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    if (t.cancelled) return false;
    const timestamp = Date.now();
    
    if (e2eeSession.active && e2eeSession.key) {
      sendFrame(fileId, t, offset, timestamp, await E2EEManager.encryptChunk(e2eeSession.key, body));
    } else {
      sendFrame(fileId, t, offset, timestamp, body);
    }
    return true;
  } catch (err) { return false; }
}

function sendFrame(fileId, t, offset, timestamp, body) {
  const frame = new Uint8Array(25 + body.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = 67; view.setBigUint64(1, BigInt(fileId)); view.setBigUint64(9, BigInt(offset)); view.setBigUint64(17, BigInt(timestamp));
  frame.set(new Uint8Array(body), 25);

  const dc = dataChannels[t.targetId];
  if (dc && dc.readyState === "open") dc.send(frame.buffer);
}

function completeTransfer(fileId) {
  const btn = document.querySelector(".send-btn");
  if (btn) { btn.textContent = "Sent!"; btn.classList.add("btn-success"); }
  setTimeout(() => resetTransferState(fileId, true), 2000);
}

function saveReceivedFile(fileId) {
  const t = incomingFiles[fileId];
  if (!t) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(t.chunks, { type: "application/octet-stream" }));
  link.download = t.name;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); document.body.removeChild(link); }, 1000);
  resetTransferState(fileId);
}

function showProgressBar() {
  const c = document.getElementById("progressContainer");
  if (c) { c.classList.remove("d-none"); c.classList.remove("expanded"); }
}
function resetProgress() {
  const c = document.getElementById("progressContainer");
  if (c) { c.classList.add("d-none"); c.classList.remove("expanded"); }
  if (document.getElementById("progressBar")) document.getElementById("progressBar").style.width = "0%";
}
function toggleProgressDetails() {
  document.getElementById("progressContainer")?.classList.toggle("expanded");
}
function updateProgress(current, total) {
  const percent = Math.min(100, Math.round((current / total) * 100)) + "%";
  const bar = document.getElementById("progressBar");
  if (bar) bar.style.width = percent;
  if (document.getElementById("progressPercentMini")) document.getElementById("progressPercentMini").textContent = percent;
  if (document.getElementById("progressPercent")) document.getElementById("progressPercent").textContent = percent;
  document.getElementById("transferDetails").textContent = `${formatBytes(current)} / ${formatBytes(total)}`;
}

function renderOnlineUsers(users) {
  const c = document.getElementById("onlineUsers");
  const s = document.getElementById("onlineUsersSection");
  if (!c || !s) return;
  c.innerHTML = "";
  const others = (users || []).filter((u) => u !== myUserId);

  if (!others.length || currentTransferMode !== 'p2p') { s.classList.add("d-none"); return; }
  s.classList.remove("d-none");
  others.forEach((u) => {
    const row = document.createElement("div");
    row.className = "online-user";
    row.innerHTML = `<div class="d-flex align-items-center gap-3"><div class="user-avatar-mini"><i class="bi bi-person-fill text-primary"></i></div><span class="user-id fw-semibold">${u}</span></div><button class="btn btn-sm btn-outline-primary px-3 rounded-pill">Select</button>`;
    row.onclick = () => { document.getElementById("userInput").value = u; document.getElementById("userInput").focus(); };
    c.appendChild(row);
  });
}

function switchTab(targetTab) {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    const active = btn.dataset.tab === targetTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active);
  });
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `${targetTab}-panel`));
  document.body.className = `tab-${targetTab}`;
  localStorage.setItem("activeTab", targetTab);
}

function initTheme() {
  const toggle = document.getElementById("settingTheme");
  const apply = (isDark) => {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    localStorage.setItem("theme", isDark ? "dark" : "light");
    if (toggle) toggle.checked = isDark;
    if (document.getElementById("themeLabel")) document.getElementById("themeLabel").textContent = isDark ? "Dark Mode" : "Light Mode";
    if (document.getElementById("themeIcon")) document.getElementById("themeIcon").className = isDark ? "bi bi-moon-stars-fill text-muted" : "bi bi-sun-fill text-warning";
  }
  apply((localStorage.getItem("theme") || "dark") === "dark");
  toggle?.addEventListener("change", (e) => apply(e.target.checked));
}

function initE2EE() {
  const toggle = document.getElementById("settingE2EE");
  const apply = (isEnabled) => {
    e2eeEnabled = isEnabled;
    localStorage.setItem("e2ee", isEnabled ? "on" : "off");
    if (toggle) toggle.checked = isEnabled;
    if (document.getElementById("e2eeLabel")) document.getElementById("e2eeLabel").textContent = isEnabled ? "E2EE Enabled" : "E2EE Disabled";
    if (document.getElementById("e2eeIcon")) document.getElementById("e2eeIcon").className = isEnabled ? "bi bi-shield-lock-fill text-success" : "bi bi-shield-lock text-muted";
  }
  apply((localStorage.getItem("e2ee") || "on") === "on");
  toggle?.addEventListener("change", (e) => apply(e.target.checked));
}

function initVisibility() {
  const toggle = document.getElementById("settingVisibility");
  const apply = (mode, skipSync) => {
    visibilityMode = mode;
    localStorage.setItem("visibility", mode);
    if (toggle) toggle.checked = (mode === 'public');
    if (document.getElementById("visibilityLabel")) document.getElementById("visibilityLabel").textContent = mode === 'public' ? "Visibility: (Public)" : "Visibility: (Private)";
    if (document.getElementById("visibilityIcon")) document.getElementById("visibilityIcon").className = mode === 'public' ? "bi bi-eye-fill text-primary" : "bi bi-eye-slash-fill text-muted";
    if (!skipSync && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "update_visibility", visibility: mode }));
  }
  apply(localStorage.getItem("visibility") || "private", true);
  toggle?.addEventListener("change", (e) => apply(e.target.checked ? 'public' : 'private'));
}

function initUploadShare() {
  const apply = (mode) => {
     if ((Object.keys(outgoingFiles).length || Object.keys(incomingFiles).length || currentUploadXHR) && mode !== currentTransferMode) {
       alert("Transfer in progress!"); return; 
     }
     currentTransferMode = mode;
     localStorage.setItem("uploadShareMode", mode);
     if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "update_mode", mode: mode }));
     
     const isP2P = mode === 'p2p';
     document.getElementById("label-send").textContent = isP2P ? "Send" : "Upload";
     document.getElementById("icon-send").className = isP2P ? "bi bi-send-fill" : "bi bi-cloud-arrow-up-fill";
     document.getElementById("label-receive").textContent = isP2P ? "Receive" : "Files";
     document.getElementById("icon-receive").className = isP2P ? "bi bi-download" : "bi bi-folder-fill";
     document.getElementById("primaryActionBtn").innerHTML = isP2P ? '<i class="bi bi-send-fill me-2"></i>Send File' : '<i class="bi bi-cloud-arrow-up-fill me-2"></i>Upload & Share';
     document.getElementById("receiveContent").classList.toggle("d-none", !isP2P);
     document.getElementById("inviteLinkSection")?.classList.toggle("d-none", !isP2P);
     document.getElementById("myFilesSection")?.classList.toggle("d-none", isP2P);
     document.getElementById("onlineUsersSection").classList.toggle("d-none", !isP2P);
     document.getElementById("userInput").closest(".mb-4").classList.toggle("d-none", !isP2P);
     document.getElementById("userInput").required = isP2P;
     document.getElementById("visibilitySettingContainer")?.classList.toggle("d-none", !isP2P);
     document.getElementById("expirySettingContainer")?.classList.toggle("d-none", isP2P);
     if (!isP2P) renderMyFiles();
 
     const radioToCheck = document.querySelector(`input[name="settingModeSelect"][value="${mode}"]`);
     if (radioToCheck) radioToCheck.checked = true;
  }
  const savedMode = localStorage.getItem("uploadShareMode") || "p2p";
  apply(savedMode);
  document.querySelectorAll('input[name="settingModeSelect"]').forEach(r => r.addEventListener("change", (e) => apply(e.target.value)));
}

function initSpeedUnit() {
  const toggle = document.getElementById("settingSpeedUnit");
  const apply = (unit) => {
    transferMetrics.speedUnit = unit;
    localStorage.setItem("speedUnit", unit);
    if (toggle) toggle.checked = (unit === 'bits');
    if (document.getElementById("speedUnitLabel")) document.getElementById("speedUnitLabel").textContent = unit === 'bits' ? "Show Speed in Mbps (Bits)" : "Show Speed in MB/s (Bytes)";
    if (document.getElementById("speedUnitIcon")) document.getElementById("speedUnitIcon").className = unit === 'bits' ? "bi bi-speedometer2 text-primary" : "bi bi-speedometer2 text-muted";
  }
  apply(localStorage.getItem("speedUnit") || "bits");
  toggle?.addEventListener("change", (e) => apply(e.target.checked ? 'bits' : 'bytes'));
}

async function handleFileUpload() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) { alert("Please select a file first."); return; }
  
  let files = JSON.parse(localStorage.getItem('myFiles') || '[]');
  const isDuplicate = files.some(f => f.name === file.name);
  if (isDuplicate) {
    alert('This file has already been uploaded!');
    return;
  }
  
  const btn = document.getElementById("primaryActionBtn");
  const originalHtml = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = 'Uploading...';
  
  const xhr = new XMLHttpRequest();
  currentUploadXHR = xhr;
  showProgressBar();
  updateE2EEUI();
  document.getElementById("progressLabelMini").textContent = file.name;
  document.getElementById("progressLabel").textContent = file.name;
  document.getElementById("detailedStatus").textContent = "Uploading to Server";
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('e2ee', e2eeEnabled);
  formData.append('sender_id', myUserId);
  formData.append('expiry_hours', document.querySelector('input[name="settingExpiry"]:checked')?.value || "24");

  transferMetrics.history = []; transferMetrics.throughput = 0;
  let previousLoaded = 0;

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      updateMetrics(e.loaded - previousLoaded);
      previousLoaded = e.loaded;
      updateProgress(e.loaded, e.total);
    }
  };

  xhr.onload = () => {
    btn.disabled = false; btn.innerHTML = originalHtml;
    if (xhr.status === 200) {
      const result = JSON.parse(xhr.responseText);
      const expiryHours = parseFloat(document.querySelector('input[name="settingExpiry"]:checked')?.value || "24");
      let expiryText = "24h";
      if (expiryHours < 1) expiryText = Math.round(expiryHours * 60) + "m";
      else if (expiryHours < 24) expiryText = expiryHours + "h";
      else if (expiryHours >= 24) expiryText = Math.round(expiryHours / 24) + "d";
      
      document.getElementById("shareableLink").value = result.download_url;
      const encryptedText = e2eeEnabled ? "Encrypted. " : "";
      document.getElementById("uploadResultFooter").textContent = `${encryptedText}Valid ${expiryText}.`;
      document.getElementById("uploadResult").classList.remove("d-none");
      saveToMyFiles(result);
      resetProgress();
    } else alert("Upload failed");
    currentUploadXHR = null;
  };
  xhr.onerror = () => { alert("Error"); currentUploadXHR = null; btn.disabled = false; btn.innerHTML = originalHtml; resetProgress(); };
  xhr.open('POST', '/upload/', true);
  xhr.send(formData);
}

function copyShareableLink() {
  const link = document.getElementById("shareableLink");
  link.select();
  navigator.clipboard.writeText(link.value);
  alert("Link copied!");
}

function shareUploadedLink() {
  const link = document.getElementById("shareableLink").value;
  if (navigator.share) navigator.share({ title: 'Download Link', url: link }).catch(console.error);
  else copyShareableLink();
}

function copyId() {
  if (myUserId) navigator.clipboard.writeText(myUserId).then(() => alert("ID Copied!"));
}

function updateInviteLink() {
  const i = document.getElementById("inviteUrl");
  if (i) {
    const url = new URL(window.location.origin + window.location.pathname);
    if (myUserId) url.searchParams.set("id", myUserId);
    i.value = url.toString();
  }
}

function copyInviteUrl() {
  updateInviteLink();
  const url = document.getElementById("inviteUrl")?.value || window.location.href;
  navigator.clipboard.writeText(url).then(() => alert("Invite link copied!")).catch(e => alert("Link: " + url));
}

window.addEventListener("DOMContentLoaded", () => {
  const savedTab = localStorage.getItem("activeTab") || "send";
  switchTab(savedTab);
  initTheme(); initE2EE(); initVisibility(); initUploadShare(); initSpeedUnit();
  document.querySelectorAll('input[name="settingExpiry"]').forEach(r => r.addEventListener('change', (e) => localStorage.setItem("settingExpiry", e.target.value)));
  if (localStorage.getItem("settingExpiry")) {
      const r = document.querySelector(`input[name="settingExpiry"][value="${localStorage.getItem("settingExpiry")}"]`);
      if (r) r.checked = true;
  }
  const inviteId = new URLSearchParams(window.location.search).get("id");
  if (inviteId) document.getElementById("userInput").value = inviteId;
  updateInviteLink(); renderMyFiles();
  document.getElementById("fileInput")?.addEventListener("change", (e) => {
    if(document.getElementById("fileNameDisplay")) document.getElementById("fileNameDisplay").textContent = e.target.files[0] ? e.target.files[0].name : "No file selected";
  });
  document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
});

window.addEventListener("beforeunload", () => {
  for (let id in outgoingFiles) cancelTransfer(id, outgoingFiles[id].targetId, true, "Unload");
  for (let id in incomingFiles) cancelTransfer(id, incomingFiles[id].senderId, false, "Unload");
});

function saveToMyFiles(fileData) {
    let files = JSON.parse(localStorage.getItem('myFiles') || '[]');
    files.unshift({ id: fileData.id, name: fileData.name, url: fileData.download_url, expires: fileData.expires_at, isEncrypted: fileData.is_encrypted_at_rest, timestamp: Date.now() });
    localStorage.setItem('myFiles', JSON.stringify(files.slice(0, 10)));
    renderMyFiles();
}

function renderMyFiles() {
    const list = document.getElementById('myFilesList');
    if (!list) return;
    let files = JSON.parse(localStorage.getItem('myFiles') || '[]');
    const now = new Date();
    files = files.filter(f => new Date(f.expires.replace(' ', 'T') + 'Z') > now);
    localStorage.setItem('myFiles', JSON.stringify(files));
    
    const getExpiryTime = (expiryStr) => {
        const expiry = new Date(expiryStr.replace(' ', 'T') + 'Z');
        return expiry.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    };
    
    list.innerHTML = files.length === 0 ? '<p class="smaller text-muted text-center py-3">No files uploaded yet.</p>' : files.map(f => `
        <div class="online-user mb-2 py-2 px-3">
            <div class="d-flex align-items-center gap-3 overflow-hidden flex-grow-1">
                <div class="user-avatar-mini" style="width: 32px; height: 32px; font-size: 1rem;"><i class="bi ${f.isEncrypted ? 'bi-shield-lock-fill text-success' : 'bi-file-earmark-text text-primary'}"></i></div>
                <div class="overflow-hidden">
                    <p class="small fw-semibold mb-0 text-clamp-2" title="${f.name}">${f.name}</p>
                    <p class="smaller text-muted mb-0" style="font-size: 0.7rem;">Expires at ${getExpiryTime(f.expires)}</p>
                </div>
            </div>
            <div class="d-flex gap-2">
                <button class="btn btn-sm btn-outline-primary p-1 border-0" onclick="window.navigator.share({title: '${f.name}', url: '${f.url}'}).catch(()=>{navigator.clipboard.writeText('${f.url}');alert('Link copied!')})"><i class="bi bi-share-fill h5 mb-0"></i></button>
                <button class="btn btn-sm btn-outline-primary p-1 border-0" onclick="window.open('${f.url}', '_blank')"><i class="bi bi-download h5 mb-0"></i></button>
                ${f.id ? `<button class="btn btn-sm btn-outline-danger p-1 border-0" onclick="deleteFile('${f.id}', this)"><i class="bi bi-trash3 h5 mb-0"></i></button>` : ''}
            </div>
        </div>`).join('');
}

function deleteFile(fileId, btn) {
    if (!fileId || fileId === 'undefined') { removeFromMyFiles(fileId); return; }
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    fetch(`/delete/${fileId}/`, { method: 'POST' }).then(async res => {
        try { if ((await res.json()).status === 'success') removeFromMyFiles(fileId); else removeFromMyFiles(fileId); } catch(e) { removeFromMyFiles(fileId); }
    }).catch(() => removeFromMyFiles(fileId));
}

function removeFromMyFiles(fileId) {
    localStorage.setItem('myFiles', JSON.stringify(JSON.parse(localStorage.getItem('myFiles') || '[]').filter(f => f.id !== fileId)));
    renderMyFiles();
}
