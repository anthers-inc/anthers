from django.contrib.auth import login, logout
from django.db.models import Count, Exists, OuterRef, Value
from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Follow, User
from .serializers import (
    LoginSerializer,
    PublicUserSerializer,
    RegisterSerializer,
    UserSerializer,
)


# ─── Auth ───


class RegisterView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        login(request, user)
        return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        login(request, user)
        return Response(UserSerializer(user).data)


class LogoutView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ─── Current User ───


class CurrentUserView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


# ─── Public Profiles ───


class CreatorListView(generics.ListAPIView):
    serializer_class = PublicUserSerializer

    def get_queryset(self):
        qs = User.objects.filter(is_creator=True, is_active=True).annotate(
            follower_count=Count("followers"),
            project_count=Count("projects"),
        )
        if self.request.user.is_authenticated:
            qs = qs.annotate(
                is_following=Exists(
                    Follow.objects.filter(
                        follower=self.request.user,
                        creator=OuterRef("pk"),
                    )
                )
            )
        else:
            qs = qs.annotate(is_following=Value(False))
        return qs


class UserProfileView(generics.RetrieveAPIView):
    """Public profile by username."""

    serializer_class = PublicUserSerializer
    lookup_field = "username"

    def get_queryset(self):
        qs = User.objects.filter(is_active=True).annotate(
            follower_count=Count("followers"),
            project_count=Count("projects"),
        )
        if self.request.user.is_authenticated:
            qs = qs.annotate(
                is_following=Exists(
                    Follow.objects.filter(
                        follower=self.request.user,
                        creator=OuterRef("pk"),
                    )
                )
            )
        else:
            qs = qs.annotate(is_following=Value(False))
        return qs


# ─── Follow / Unfollow ───


class FollowView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, username):
        try:
            creator = User.objects.get(username=username, is_active=True)
        except User.DoesNotExist:
            return Response(
                {"detail": "User not found."}, status=status.HTTP_404_NOT_FOUND
            )
        if creator == request.user:
            return Response(
                {"detail": "You cannot follow yourself."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        Follow.objects.get_or_create(follower=request.user, creator=creator)
        return Response({"detail": "Followed."}, status=status.HTTP_201_CREATED)


class UnfollowView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, username):
        deleted, _ = Follow.objects.filter(
            follower=request.user, creator__username=username
        ).delete()
        if not deleted:
            return Response(
                {"detail": "You were not following this user."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


# ─── Following list + Feed ───


class FollowingListView(generics.ListAPIView):
    """List creators the current user follows."""

    serializer_class = PublicUserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        return (
            User.objects.filter(followers__follower=self.request.user)
            .annotate(
                follower_count=Count("followers"),
                project_count=Count("projects"),
                is_following=Value(True),
            )
        )


class FeedView(generics.ListAPIView):
    """Posts from creators the current user follows."""

    permission_classes = [permissions.IsAuthenticated]

    def get_queryset(self):
        from content.models import Post

        followed_ids = Follow.objects.filter(
            follower=self.request.user
        ).values_list("creator_id", flat=True)
        return Post.objects.filter(
            creator_id__in=followed_ids, is_published=True
        ).select_related("creator", "project")

    def get_serializer_class(self):
        from content.serializers import PostSerializer

        return PostSerializer
