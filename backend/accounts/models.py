from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    display_name = models.CharField(max_length=150, blank=True)
    bio = models.TextField(blank=True)
    is_creator = models.BooleanField(default=False)
    avatar = models.ImageField(upload_to="avatars/", blank=True)

    def __str__(self):
        return self.display_name or self.username
