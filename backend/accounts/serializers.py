from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from .models import User


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = (
            "id", "username", "display_name", "bio", "is_creator",
            "avatar", "header_image", "website_url", "location",
            "atproto_did", "atproto_handle",
        )
        read_only_fields = ("id", "username", "atproto_did", "atproto_handle")


class PublicUserSerializer(serializers.ModelSerializer):
    """Public profile — includes computed counts."""

    follower_count = serializers.IntegerField(read_only=True)
    project_count = serializers.IntegerField(read_only=True)
    is_following = serializers.BooleanField(read_only=True, default=False)

    class Meta:
        model = User
        fields = (
            "id", "username", "display_name", "bio", "is_creator",
            "avatar", "header_image", "website_url", "location",
            "atproto_did", "atproto_handle",
            "follower_count", "project_count", "is_following", "date_joined",
        )


class RegisterSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150)
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)
    password_confirm = serializers.CharField(write_only=True)

    def validate_username(self, value):
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("A user with that username already exists.")
        return value

    def validate_email(self, value):
        if User.objects.filter(email__iexact=value).exists():
            raise serializers.ValidationError("A user with that email already exists.")
        return value

    def validate_password(self, value):
        validate_password(value)
        return value

    def validate(self, data):
        if data["password"] != data["password_confirm"]:
            raise serializers.ValidationError({"password_confirm": "Passwords do not match."})
        return data

    def create(self, validated_data):
        validated_data.pop("password_confirm")
        user = User.objects.create_user(
            username=validated_data["username"],
            email=validated_data["email"],
            password=validated_data["password"],
        )
        return user


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField()
    password = serializers.CharField(write_only=True)

    def validate(self, data):
        user = authenticate(
            username=data["username"],
            password=data["password"],
        )
        if user is None:
            raise serializers.ValidationError("Invalid username or password.")
        if not user.is_active:
            raise serializers.ValidationError("This account is inactive.")
        data["user"] = user
        return data
