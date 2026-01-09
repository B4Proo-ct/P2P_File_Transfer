import secrets
import json
import logging
import re
import hashlib
import time
from urllib.parse import parse_qs
from channels.generic.websocket import AsyncWebsocketConsumer

logger = logging.getLogger(__name__)
_discovery_groups = {}

class FileTransferConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        query_params = parse_qs(self.scope.get('query_string', b'').decode())
        requested_uid = query_params.get('uid', [None])[0]
        
        if requested_uid and re.fullmatch(r"[0-9a-f]{8}", requested_uid):
            self.user_id = requested_uid
        else:
            self.user_id = secrets.token_hex(4)

        self.current_mode = "p2p"
        self.visibility = "private"
        self.active_groups = set()
        
        self.personal_group = f"user_{self.user_id}"
        await self.channel_layer.group_add(self.personal_group, self.channel_name)

        await self.accept()
        await self.send(text_data=json.dumps({"type": "user_id", "user_id": self.user_id}))

    def _get_discovery_identifier(self):
        headers = dict(self.scope.get('headers', []))
        host = headers.get(b'host', b'').decode().lower()
        ip = headers.get(b'x-forwarded-for', b'').decode().split(',')[0].strip() or self.scope.get('client', ["unknown"])[0]
        
        if not any(x in host for x in ['localhost', '127.0.0.1', '192.168.', '10.', '172.']):
            if ":" in ip:
                prefix = ":".join(ip.split(':')[:4])
                return f"tunnel_{host}_{prefix}"
            return f"tunnel_{host}_{ip}"
            
        if ip.startswith(("192.168.", "10.", "172.")):
            return f"local_{'.'.join(ip.split('.')[:3])}"
        return f"local_{ip}"

    async def disconnect(self, close_code):
        for g in self.active_groups:
            if g in _discovery_groups and self.user_id in _discovery_groups[g]: del _discovery_groups[g][self.user_id]
            await self.channel_layer.group_discard(g, self.channel_name)
        if hasattr(self, 'personal_group'): await self.channel_layer.group_discard(self.personal_group, self.channel_name)
        await self.broadcast_user_list()

    async def broadcast_user_list(self, extra_groups=None):
        now = time.time()
        targets = self.active_groups | (extra_groups or set())

        for g in list(_discovery_groups.keys()):
            original_count = len(_discovery_groups[g])
            _discovery_groups[g] = {uid: info for uid, info in _discovery_groups[g].items() if now - info["last_seen"] < 2.5}
            
            if len(_discovery_groups[g]) != original_count:
                targets.add(g)

            if not _discovery_groups[g]: del _discovery_groups[g]
            
        for g in targets: 
            await self.channel_layer.group_send(g, {"type": "sync.list"})

    async def sync_list(self, event):
        now, peers = time.time(), set()
        for g in self.active_groups:
            for uid, info in _discovery_groups.get(g, {}).items():
                if uid != self.user_id and info.get("mode") == "p2p" and now - info.get("last_seen", 0) < 2.5:
                    peers.add(uid)
        await self.send(text_data=json.dumps({"type": "users", "users": list(peers)}))

    async def receive(self, text_data=None, bytes_data=None):
        if not text_data: return
        try:
            content = json.loads(text_data)
            mtype, tid = content.get("type"), content.get("target_user_id")
            
            if mtype == "ping":
                for g in self.active_groups:
                    if self.user_id in _discovery_groups.get(g, {}): _discovery_groups[g][self.user_id]["last_seen"] = time.time()
                await self.send(text_data=json.dumps({"type": "pong"}))
            elif mtype == "update_mode":
                self.current_mode = content.get("mode", "p2p")
                for g in self.active_groups:
                    if self.user_id in _discovery_groups.get(g, {}): _discovery_groups[g][self.user_id]["mode"] = self.current_mode
                await self.broadcast_user_list()
            elif mtype == "update_visibility":
                self.visibility = content.get("visibility", "private")
                old_groups = self.active_groups.copy()
                
                raw_id = self._get_discovery_identifier()
                gid = f"disc_{hashlib.sha256(raw_id.encode()).hexdigest()[:16]}"
                groups = {gid}
                inv = parse_qs(self.scope.get('query_string', b'').decode()).get('id', [None])[0]
                if inv: groups.add(f"inv_{inv}")
                if self.visibility == "public": groups.add("global_public")
                
                for g in (self.active_groups - groups):
                    if g in _discovery_groups and self.user_id in _discovery_groups[g]: del _discovery_groups[g][self.user_id]
                    await self.channel_layer.group_discard(g, self.channel_name)
                for g in (groups - self.active_groups):
                    if g not in _discovery_groups: _discovery_groups[g] = {}
                    _discovery_groups[g][self.user_id] = {"mode": self.current_mode, "last_seen": time.time()}
                    await self.channel_layer.group_add(g, self.channel_name)
                self.active_groups = groups
                await self.broadcast_user_list(extra_groups=old_groups)
            elif tid and mtype in ["file_offer", "file_response", "file_cancel", "webrtc_offer", "webrtc_answer", "webrtc_ice", "e2ee_fingerprint"]:
                await self.channel_layer.group_send(f"user_{str(tid)}", {"type": "p2p.signal", "payload": content, "sender_id": self.user_id})
        except Exception as e: logger.error(f"WS error: {e}")

    async def p2p_signal(self, event):
        p = event["payload"]
        p["sender_id"] = event["sender_id"]
        await self.send(text_data=json.dumps(p))
