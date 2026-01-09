"""Defines URL patterns for fileshare"""

from django.urls import path
from . import views

app_name = "fileshare"
urlpatterns = [
    path("", views.index, name="index"),
    path("upload/", views.upload_shared_file, name="upload"),
    path("download/<uuid:file_id>/", views.download_shared_file, name="download"),
    path("delete/<uuid:file_id>/", views.delete_shared_file, name="delete"),
]
