#!/usr/bin/env python3
"""Write cleaned markdown files to the Obsidian wiki directory."""
import re
import os
import json
import sys


def cleanup(body, title):
    """Apply all cleanup rules to a markdown body."""
    # Strip trailing triple-space at end of lines
    body = re.sub(r'   $', '', body, flags=re.MULTILINE)

    # Strip anytype:// links in markdown link format [text](anytype://...)
    body = re.sub(r'\[([^\]]+)\]\(anytype://[^)]*\)', r'\1', body)

    # Strip bare anytype:// URLs
    body = re.sub(r'anytype://\S+', '', body)

    # Strip leading " --- \n" lines at the very start of the body
    body = re.sub(r'^(\s*---\s*\n)+', '', body)

    # Strip escaped underscores that Anytype adds
    body = body.replace('\\_', '_')

    # Add title heading
    result = f"# {title}\n\n{body}"

    # Ensure file ends with a single newline
    result = result.rstrip() + '\n'

    return result


def main():
    target_dir = "/home/parker/Obsidian/Bluebell/01-Wiki/30-39 Architecture"

    # Read the JSON data from stdin
    data = json.load(sys.stdin)

    for entry in data:
        filename = entry["filename"]
        title = entry["title"]
        body = entry["body"]

        content = cleanup(body, title)
        filepath = os.path.join(target_dir, filename)
        with open(filepath, 'w') as f:
            f.write(content)
        print(f"  Wrote: {filename} ({len(content)} chars)")

    print(f"\nDone. Wrote {len(data)} files to {target_dir}")


if __name__ == "__main__":
    main()
