#!/usr/bin/env python3
"""Test Claude vision API for extracting color and form metadata from mosaic images."""
from __future__ import annotations
import base64
import json
from pathlib import Path

import anthropic

REFERENCE_ROOT = Path(__file__).parent.parent / "references"
CLIENT = anthropic.Anthropic()

PROMPT = """You are analyzing a Space Invader mosaic — a small pixel-art tile mosaic installed on a wall by the street artist Invader.

Analyze this image and return a JSON object with exactly these fields:

{
  "dominant_colors": ["<color name>", ...],   // 2-5 most prominent tile colors, plain English (e.g. "white", "light blue", "dark red")
  "background_color": "<color name>",          // color of the background/wall tiles
  "grid_size": "<WxH>",                        // approximate tile grid dimensions (e.g. "11x9", "7x7") — count the tiles
  "character_type": "<type>",                  // what the mosaic depicts: "alien", "face", "character", "logo", "abstract", "animal", "robot", "other"
  "symmetry": "<symmetry>",                    // "horizontal", "vertical", "both", "none"
  "description": "<one sentence>"              // brief visual description of the design
}

Return only valid JSON, no other text."""


def best_image(invader_id: str) -> Path | None:
    base = REFERENCE_ROOT / invader_id.split("_")[0] / invader_id
    meta_path = base / "metadata.json"
    if not meta_path.exists():
        return None
    meta = json.loads(meta_path.read_text())
    for role in ("grosplan", "reference"):
        for img in meta.get("images", []):
            if img.get("role") == role and img.get("contains_invader", True):
                p = REFERENCE_ROOT.parent / img["local_path"]
                if p.exists():
                    return p
    return None


def extract(invader_id: str) -> dict | None:
    img_path = best_image(invader_id)
    if not img_path:
        print(f"  {invader_id}: no image found")
        return None

    suffix = img_path.suffix.lower().lstrip(".")
    media_type = "image/png" if suffix == "png" else "image/jpeg"
    data = base64.standard_b64encode(img_path.read_bytes()).decode()

    response = CLIENT.messages.create(
        model="claude-opus-4-7",
        max_tokens=512,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
                {"type": "text", "text": PROMPT},
            ],
        }],
    )

    try:
        result = json.loads(response.content[0].text)
        result["invader_id"] = invader_id
        result["image_path"] = str(img_path)
        return result
    except json.JSONDecodeError as e:
        print(f"  {invader_id}: JSON parse error — {response.content[0].text[:100]}")
        return None


if __name__ == "__main__":
    test_ids = ["PA_10", "PA_42", "PA_100", "PA_200", "PA_300"]

    for invader_id in test_ids:
        print(f"\n{invader_id}:")
        result = extract(invader_id)
        if result:
            print(json.dumps(result, indent=2, ensure_ascii=False))
