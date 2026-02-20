from rest_framework import generics, permissions

from .models import User
from .serializers import UserSerializer


class CurrentUserView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    permission_classes = [permissions.IsAuthenticated]

    def get_object(self):
        return self.request.user


class CreatorListView(generics.ListAPIView):
    serializer_class = UserSerializer
    queryset = User.objects.filter(is_creator=True, is_active=True)
