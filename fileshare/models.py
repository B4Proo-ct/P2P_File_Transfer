import uuid
from django.db import models
from django.utils import timezone

class SharedFile(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    file = models.FileField(upload_to='uploaded_files/')
    name = models.CharField(max_length=255)
    size = models.BigIntegerField()
    uploader_id = models.CharField(max_length=100, null=True, blank=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()

    def __str__(self): return self.name
    def is_expired(self): return timezone.now() > self.expires_at
