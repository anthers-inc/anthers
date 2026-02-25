from django.urls import path

from . import views

app_name = "accounts"

urlpatterns = [
    # Auth
    path("register/", views.RegisterView.as_view(), name="register"),
    path("login/", views.LoginView.as_view(), name="login"),
    path("logout/", views.LogoutView.as_view(), name="logout"),
    # Current user
    path("me/", views.CurrentUserView.as_view(), name="current-user"),
    path("me/following/", views.FollowingListView.as_view(), name="following-list"),
    path("me/feed/", views.FeedView.as_view(), name="feed"),
    # Public profiles
    path("creators/", views.CreatorListView.as_view(), name="creator-list"),
    path("users/<str:username>/", views.UserProfileView.as_view(), name="user-profile"),
    path("users/<str:username>/follow/", views.FollowView.as_view(), name="follow"),
    path("users/<str:username>/unfollow/", views.UnfollowView.as_view(), name="unfollow"),
    # ATProto / Bluesky
    path(
        "atproto/client-metadata.json",
        views.ATProtoClientMetadataView.as_view(),
        name="atproto-client-metadata",
    ),
    path("atproto/auth/", views.ATProtoAuthInitView.as_view(), name="atproto-auth"),
    path("atproto/callback/", views.ATProtoCallbackView.as_view(), name="atproto-callback"),
    path("atproto/unlink/", views.ATProtoUnlinkView.as_view(), name="atproto-unlink"),
]
