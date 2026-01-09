# 🔗 P2P File Transfer (Hybrid)

<p align="center">
  <img src="fileshare/static/favicon.png" width="200" alt="Logo Icon"/><br>
  A secure, fast, and browser-based file sharing system built using Python & Django.  
  It supports direct peer-to-peer transfer and a backup Upload & Share mode, so file sharing always works — no matter the network.
</p>

---

## 📌 What is this project?

**P2P File Transfer** allows users to share files in two smart ways:

### 🔁 1. Peer-to-Peer (P2P) Mode
- Files are sent **directly from sender to receiver**
- Works best on **same Wi-Fi / local network**
- Extremely fast ⚡
- No server storage involved
- End-to-End Encrypted

### ☁️ 2. Upload & Share Mode
- Used when P2P is not possible (different networks / offline user)
- File is **encrypted and uploaded temporarily**
- A **secure shareable link** is generated
- File is **auto-deleted after a short time**

This **hybrid approach** ensures the transfer never fails.

---

## 🧠 Why is this useful? (Simple words)

- 🚫 No need for Google Drive, WhatsApp, or Email
- ⚡ Much faster than cloud apps on local Wi-Fi
- 🔐 Files stay private with encryption
- 🌍 Works on any modern browser (mobile & desktop)
- 🧪 Great real-world project for learning networking concepts

---

## ✨ Features

### 🔄 Transfer Modes
- ✅ **Live P2P Transfer** (WebRTC based)
- ✅ **Upload & Share** fallback mode

### 🔐 Privacy & Security
- End-to-End Encryption (E2EE) for P2P transfers
- Encrypted storage for uploaded files
- Private rooms using unique Room IDs
- No account or name required

### 📁 File Handling
- Chunk-based transfer (handles large files safely)
- Real-time progress bar & speed indicator
- Auto cleanup of uploaded files

### 🖥️ User Interface
- Dark mode with modern UI
- Mobile & desktop responsive
- Separate tabs for Send / Receive / Settings

---

## 🧩 Tech Stack

- Backend: Django (Python)
- Realtime: Django Channels + WebSockets
- P2P: WebRTC
- Encryption: Web Crypto API / Fernet
- Frontend: Vanilla JavaScript + CSS

---

## ⚙️ Run Locally

### 1️⃣ Clone the repository
```bash
git clone https://github.com/ShivamXD6/P2P_File_Transfer
cd path/to/root/directory
pip install uv
```

### 2️⃣ Rename env.example to .env and modify it
```bash
SECRET_KEY="example_secret_key"  # https://stackoverflow.com/a/57678930
ENCRYPTION_KEY="example_encryption_key"  # https://cryptography.io/en/latest/fernet/#cryptography.fernet.Fernet
DEBUG=True  # For development
```

### 3️⃣ Run database migrations
```bash
python -m uv run manage.py migrate
```

### 4️⃣ Start the development server
```bash
uv run python manage.py runserver 0.0.0.0:8000
```

### 5️⃣ Open in browser
```bash
localhost:8000
```

---

## 🖼️ Screenshots
### 🔁 Peer-to-Peer Transfer Mode
<img width="301" height="477" alt="{6C1B3FF7-6A60-4CEC-B15C-6CF3F4CF6F36}" src="https://github.com/user-attachments/assets/e7d9ce36-71ea-4889-b5f3-a06fe2cf52af" />
<img width="304" height="363" alt="{7FE0E4E5-2C20-452C-8EF2-5D3089B1BC14}" src="https://github.com/user-attachments/assets/ce7aa9db-65fb-4fa1-8055-f59ee87885f0" />
<img width="304" height="360" alt="{3976A217-B038-489E-BAC1-12B88D696D86}" src="https://github.com/user-attachments/assets/57578e85-57f3-4b0f-972b-dde701f73087" />


### ☁️ Upload & Share Mode
<img width="293" height="358" alt="{19546530-5641-4BF2-879E-F04CC7D5E165}" src="https://github.com/user-attachments/assets/83d15b82-b846-427d-bd69-7b14b944968d" />
<img width="309" height="271" alt="{5A1CD1E1-4328-4D3D-8CE5-D99A7D139F6D}" src="https://github.com/user-attachments/assets/df227264-e5a3-4d99-a65c-521cd45f54fc" />
<img width="296" height="374" alt="{081EA912-86C4-40AB-B901-D18868C4852B}" src="https://github.com/user-attachments/assets/89ea7582-a361-48a1-9761-c4f17c1db427" />
