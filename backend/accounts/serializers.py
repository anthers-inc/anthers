from rest_framework import serializers

from .models import User


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ("id", "username", "display_name", "bio", "is_creator", "avatar")
        read_only_fields = ("id", "username")
