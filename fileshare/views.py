import os, uuid, io
from django.shortcuts import render, get_object_or_404
from django.http import JsonResponse, FileResponse
from django.views.decorators.csrf import csrf_exempt
from .models import SharedFile
from django.utils import timezone
from datetime import timedelta
from django.conf import settings
from cryptography.fernet import Fernet
import base64
from django.urls import reverse

def get_fernet():
    return Fernet(base64.urlsafe_b64encode(settings.SECRET_KEY[:32].encode().ljust(32, b'0')))

def cleanup_expired_files():
    """Delete expired files from both database and disk"""
    expired_files = SharedFile.objects.filter(expires_at__lt=timezone.now())
    for shared_file in expired_files:
        try:
            if shared_file.file and os.path.exists(shared_file.file.path):
                os.remove(shared_file.file.path)
        except Exception as e:
            print(f"Error deleting file {shared_file.id}: {e}")
    expired_files.delete()

def index(request): 
    cleanup_expired_files()
    return render(request, 'fileshare/index.html')

@csrf_exempt
def upload_shared_file(request):
    cleanup_expired_files()

    if request.method == 'POST' and request.FILES.get('file'):
        file, e2ee_on, uploader_id = request.FILES['file'], request.POST.get('e2ee') == 'true', request.POST.get('sender_id')
        try: expiry_hours = float(request.POST.get('expiry_hours', 24))
        except ValueError: expiry_hours = 24
        
        shared_file = SharedFile.objects.create(name=file.name, size=file.size, expires_at=timezone.now() + timedelta(hours=expiry_hours), uploader_id=uploader_id if e2ee_on else None)
        data, is_encrypted = file.read(), False
        
        if e2ee_on:
            data, is_encrypted = get_fernet().encrypt(data), True
            
        filename = f"{shared_file.id}_{file.name}"
        upload_dir = os.path.join(settings.MEDIA_ROOT, 'uploaded_files')
        os.makedirs(upload_dir, exist_ok=True)
        filepath = os.path.join(upload_dir, filename)
        with open(filepath, 'wb') as f: f.write(data)
        
        shared_file.file = os.path.join('uploaded_files', filename)
        shared_file.save()
        
        download_url = request.build_absolute_uri(reverse('fileshare:download', args=[shared_file.id]))
        if e2ee_on and uploader_id: download_url += f"?uid={uploader_id}"
        
        return JsonResponse({'status': 'success', 'download_url': download_url, 'id': str(shared_file.id), 'name': shared_file.name, 'is_encrypted_at_rest': is_encrypted, 'expires_at': shared_file.expires_at.strftime("%Y-%m-%d %H:%M:%S")})
    return JsonResponse({'status': 'error', 'message': 'No file uploaded'}, status=400)

def download_shared_file(request, file_id):
    shared_file = SharedFile.objects.filter(id=file_id).first()
    if not shared_file: return render(request, "fileshare/error.html", {"title": "File Not Found", "message": "File does not exist or expired.", "icon": "bi-file-earmark-x-fill"}, status=404)

    if shared_file.is_expired():
        if shared_file.file and os.path.exists(shared_file.file.path): os.remove(shared_file.file.path)
        shared_file.delete()
        return render(request, "fileshare/error.html", {"title": "Link Expired", "message": "Download link expired.", "icon": "bi-hourglass-bottom"}, status=410)

    if shared_file.uploader_id:
        provided_uid = request.GET.get('uid')
        if not provided_uid: return render(request, "fileshare/error.html", {"title": "Download Restricted", "message": "Unique ID required.", "icon": "bi-shield-exclamation"}, status=403)
        if provided_uid != shared_file.uploader_id: return render(request, "fileshare/error.html", {"title": "Access Denied", "message": "Invalid Unique ID.", "icon": "bi-shield-x"}, status=403)
        
    try:
        if not shared_file.file or not os.path.exists(shared_file.file.path): return render(request, "fileshare/error.html", {"title": "File Missing", "message": "File missing on server.", "icon": "bi-file-break-fill"}, status=404)
        with open(shared_file.file.path, 'rb') as f: data = f.read()
        if data.startswith(b'gAAAA'): 
            try: data = get_fernet().decrypt(data)
            except: pass
            
        resp = FileResponse(io.BytesIO(data), as_attachment=True, filename=shared_file.name, content_type='application/octet-stream')
        resp['Content-Length'] = len(data)
        return resp
    except Exception as e:
        print(f"Download Error: {e}")
        return render(request, "fileshare/error.html", {"title": "Server Error", "message": "Unexpected error.", "icon": "bi-exclamation-octagon-fill"}, status=500)

@csrf_exempt
def delete_shared_file(request, file_id):
    if request.method == 'POST':
        shared_file = get_object_or_404(SharedFile, id=file_id)
        try:
            if shared_file.file and os.path.exists(shared_file.file.path): os.remove(shared_file.file.path)
            shared_file.delete()
            return JsonResponse({'status': 'success', 'message': 'File deleted'})
        except Exception as e: return JsonResponse({'status': 'error', 'message': str(e)}, status=500)
    return JsonResponse({'status': 'error', 'message': 'Invalid request'}, status=400)
