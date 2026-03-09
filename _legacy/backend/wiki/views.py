"""
Views for serving wiki markdown documentation.

Provides the public wiki endpoint for user-facing documentation.
"""

import os
import logging
from pathlib import Path

from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response
from rest_framework.permissions import AllowAny

logger = logging.getLogger(__name__)

# Wiki directories
# In Docker: backend is mounted at /app, wiki is at project root
BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

# Check if running in Docker (wiki mounted at /wiki) or local dev
DOCKER_WIKI_PATH = Path("/wiki")
if DOCKER_WIKI_PATH.exists():
    WIKI_DIR = DOCKER_WIKI_PATH
else:
    WIKI_DIR = PROJECT_ROOT / "wiki"


def _read_wiki_file(base_dir: Path, section: str, filename: str) -> tuple[str | None, str | None]:
    """
    Read a markdown file from the wiki directory.

    Args:
        base_dir: Base directory for wiki files
        section: Section subdirectory (e.g., "10-Getting-Started")
        filename: Markdown filename (e.g., "README.md")

    Returns:
        Tuple of (content, error_message). One will be None.
    """
    # Security: Prevent directory traversal
    section = os.path.normpath(section).replace("..", "").lstrip("/")
    filename = os.path.normpath(filename).replace("..", "").lstrip("/")

    file_path = base_dir / section / filename

    try:
        file_path = file_path.resolve()

        # Verify the file is within the allowed directory
        if not file_path.is_relative_to(base_dir):
            return None, "Invalid file path"

        if not file_path.exists():
            return None, "File not found"

        if not file_path.is_file():
            return None, "Path is not a file"

        # Read and return the markdown content
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        return content, None

    except Exception as e:
        logger.error(f"Error reading wiki file {section}/{filename}: {e}")
        return None, f"Failed to read file: {str(e)}"


@api_view(["GET"])
@permission_classes([AllowAny])
def wiki_content_view(request, section: str, filename: str):
    """
    Serve wiki markdown content.

    Reads markdown files from the /wiki directory. Public endpoint --
    no authentication required since the wiki is user-facing documentation.

    Path parameters:
        section: Directory name (e.g., "10-Getting-Started", "20-Users")
        filename: Markdown file name (e.g., "README.md", "01-WhatIsBluebell.md")

    Response:
        {
            "content": "# Markdown content...",
            "section": "10-Getting-Started",
            "filename": "README.md"
        }
    """
    content, error = _read_wiki_file(WIKI_DIR, section, filename)

    if error:
        status_code = status.HTTP_404_NOT_FOUND if error == "File not found" else status.HTTP_400_BAD_REQUEST
        return Response({
            "error": error,
            "section": section,
            "filename": filename,
        }, status=status_code)

    return Response({
        "content": content,
        "section": section,
        "filename": filename,
    })
