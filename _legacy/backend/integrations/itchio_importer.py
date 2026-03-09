"""
itch.io public metadata scraper for project import.

Scrapes publicly visible game pages to extract title, description, cover image,
tags, and other metadata. Creates draft (unpublished) Project objects.
"""

import logging
import re
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

ITCHIO_TIMEOUT = 15


def fetch_user_games(username: str) -> list[dict]:
    """Fetch the list of public games for an itch.io user.

    Returns a list of dicts with keys: url, title, cover_image, short_description.
    """
    url = f"https://{username}.itch.io/"
    try:
        resp = requests.get(url, timeout=ITCHIO_TIMEOUT, headers={
            "User-Agent": "Bluebell/1.0 (game platform importer)",
        })
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning("Failed to fetch itch.io user page %s: %s", url, e)
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    games = []

    for cell in soup.select(".game_cell"):
        link_el = cell.select_one("a.game_link, .game_title a, a.title")
        if not link_el:
            link_el = cell.select_one("a[href]")
        if not link_el:
            continue

        game_url = link_el.get("href", "")
        title = link_el.get_text(strip=True)

        cover_el = cell.select_one(".game_thumb img, .lazy_loaded, img")
        cover_image = ""
        if cover_el:
            cover_image = cover_el.get("data-lazy_loaded", "") or cover_el.get("src", "")

        desc_el = cell.select_one(".game_text")
        short_desc = desc_el.get_text(strip=True) if desc_el else ""

        games.append({
            "url": game_url,
            "title": title,
            "cover_image": cover_image,
            "short_description": short_desc[:300],
        })

    return games


def fetch_game_details(game_url: str) -> dict | None:
    """Scrape detailed metadata from an itch.io game page.

    Returns a dict with: title, description, short_description, cover_image,
    tags, media_type, embed_url, website_url, screenshots.
    """
    try:
        resp = requests.get(game_url, timeout=ITCHIO_TIMEOUT, headers={
            "User-Agent": "Bluebell/1.0 (game platform importer)",
        })
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.warning("Failed to fetch itch.io game page %s: %s", game_url, e)
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # Title
    title_el = soup.select_one(".game_title, h1.title")
    title = title_el.get_text(strip=True) if title_el else ""

    # Description
    desc_el = soup.select_one(".formatted_description, .game_description")
    description = ""
    short_description = ""
    if desc_el:
        description = desc_el.get_text(separator="\n", strip=True)
        short_description = description[:300]

    # Cover image
    cover_el = soup.select_one(".header img, .game_cover img, meta[property='og:image']")
    cover_image = ""
    if cover_el:
        if cover_el.name == "meta":
            cover_image = cover_el.get("content", "")
        else:
            cover_image = cover_el.get("src", "")
    if not cover_image:
        og_image = soup.select_one("meta[property='og:image']")
        if og_image:
            cover_image = og_image.get("content", "")

    # Tags
    tags = []
    for tag_el in soup.select(".game_info_panel_widget a[href*='/tag/'], a.tag"):
        tag_text = tag_el.get_text(strip=True).lower()
        if tag_text:
            tags.append(tag_text)

    # Media type detection
    media_type = "game"  # Default for itch.io

    # Check for HTML5/embed game
    embed_url = ""
    iframe_el = soup.select_one(".html_embed_widget iframe, #game_drop iframe")
    if iframe_el:
        embed_url = iframe_el.get("src", "")

    # Screenshots
    screenshots = []
    for img_el in soup.select(".screenshot_list a img, .screenshot img"):
        src = img_el.get("src", "")
        if src:
            screenshots.append(src)

    # Source URL (itch.io page itself)
    source_url = game_url

    return {
        "title": title,
        "description": description,
        "short_description": short_description,
        "cover_image": cover_image,
        "tags": tags[:10],  # Limit to 10 tags
        "media_type": media_type,
        "embed_url": embed_url,
        "source_url": source_url,
        "screenshots": screenshots[:8],  # Limit screenshots
    }


def import_game_as_project(user, game_data: dict, *, download_images: bool = True):
    """Create a draft Project from scraped itch.io game data.

    Returns the created Project instance.
    """
    from django.utils.text import slugify
    from content.models import Project

    title = game_data.get("title", "Untitled Import")

    # Generate a unique slug
    base_slug = slugify(title)[:200]
    slug = base_slug
    counter = 1
    while Project.objects.filter(slug=slug).exists():
        slug = f"{base_slug}-{counter}"
        counter += 1

    project = Project.objects.create(
        creator=user,
        title=title,
        slug=slug,
        description=game_data.get("description", ""),
        short_description=game_data.get("short_description", ""),
        media_type=game_data.get("media_type", "game"),
        tags=game_data.get("tags", []),
        embed_url=game_data.get("embed_url", ""),
        source_url=game_data.get("source_url", ""),
        is_published=False,  # Always create as draft
        pricing_type=Project.PricingType.FREE,
    )

    # Download and attach cover image
    if download_images and game_data.get("cover_image"):
        _download_and_attach_cover(project, game_data["cover_image"])

    # Download and attach screenshots
    if download_images and game_data.get("screenshots"):
        _download_and_attach_screenshots(project, game_data["screenshots"])

    return project


def _download_and_attach_cover(project, image_url: str):
    """Download a remote image and attach it as the project cover."""
    import tempfile
    import os
    from django.core.files import File

    try:
        resp = requests.get(image_url, timeout=ITCHIO_TIMEOUT, stream=True)
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")
        ext = ".jpg"
        if "png" in content_type:
            ext = ".png"
        elif "gif" in content_type:
            ext = ".gif"
        elif "webp" in content_type:
            ext = ".webp"

        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
            tmp_path = f.name

        with open(tmp_path, "rb") as f:
            filename = f"import-{project.slug}{ext}"
            project.cover_image.save(filename, File(f), save=True)

        os.unlink(tmp_path)
    except Exception as e:
        logger.warning("Failed to download cover image for %s: %s", project.slug, e)


def _download_and_attach_screenshots(project, image_urls: list[str]):
    """Download remote images and attach them as project screenshots."""
    import tempfile
    import os
    from django.core.files import File
    from content.models import Screenshot

    for i, url in enumerate(image_urls):
        try:
            resp = requests.get(url, timeout=ITCHIO_TIMEOUT, stream=True)
            resp.raise_for_status()

            content_type = resp.headers.get("content-type", "")
            ext = ".jpg"
            if "png" in content_type:
                ext = ".png"
            elif "gif" in content_type:
                ext = ".gif"

            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
                tmp_path = f.name

            with open(tmp_path, "rb") as f:
                filename = f"import-{project.slug}-{i}{ext}"
                screenshot = Screenshot(project=project, sort_order=i)
                screenshot.image.save(filename, File(f), save=True)

            os.unlink(tmp_path)
        except Exception as e:
            logger.warning(
                "Failed to download screenshot %d for %s: %s", i, project.slug, e
            )
