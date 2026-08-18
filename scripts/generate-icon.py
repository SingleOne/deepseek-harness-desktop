from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


SIZE = 1024
ICON_CROP_BOUNDS = (76, 76, 949, 949)
ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "resources"
BASE_ICON = OUTPUT_DIRECTORY / "icon-base-whale.png"
WHALE_COLOR = (93, 131, 255)


def color_lerp(start: tuple[int, int, int], end: tuple[int, int, int], amount: float):
    return tuple(round(left + (right - left) * amount) for left, right in zip(start, end))


def cubic_segment(
    start: tuple[float, float],
    control_1: tuple[float, float],
    control_2: tuple[float, float],
    end: tuple[float, float],
    steps: int = 32,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for step in range(1, steps + 1):
        amount = step / steps
        inverse = 1 - amount
        points.append(
            (
                inverse**3 * start[0]
                + 3 * inverse**2 * amount * control_1[0]
                + 3 * inverse * amount**2 * control_2[0]
                + amount**3 * end[0],
                inverse**3 * start[1]
                + 3 * inverse**2 * amount * control_1[1]
                + 3 * inverse * amount**2 * control_2[1]
                + amount**3 * end[1],
            )
        )
    return points


def rounded_line(
    image: Image.Image,
    points: list[tuple[int, int]],
    width: int,
    color: tuple[int, int, int, int],
) -> None:
    draw = ImageDraw.Draw(image)
    draw.line(points, fill=color, width=width, joint="curve")
    radius = width // 2
    for x, y in points:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color)


def render_background() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    tile_bounds = (76, 76, 948, 948)
    tile_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle(tile_bounds, radius=226, fill=255)

    gradient = Image.new("RGBA", (SIZE, SIZE))
    gradient_pixels = gradient.load()
    for y in range(SIZE):
        color = color_lerp((15, 34, 59), (5, 15, 28), y / (SIZE - 1))
        for x in range(SIZE):
            gradient_pixels[x, y] = (*color, 255)

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((35, 10, 710, 685), fill=(79, 124, 255, 74))
    gradient = Image.alpha_composite(gradient, glow.filter(ImageFilter.GaussianBlur(120)))
    canvas.paste(gradient, (0, 0), tile_mask)
    ImageDraw.Draw(canvas).rounded_rectangle(
        tile_bounds,
        radius=226,
        outline=(41, 72, 118, 255),
        width=18,
    )
    return canvas


def extract_whale_without_fin(base_icon: Image.Image) -> Image.Image:
    mask = Image.new("L", (SIZE, SIZE), 0)
    mask.putdata([
        255 if pixel[:3] == WHALE_COLOR and pixel[3] == 255 else 0
        for pixel in base_icon.get_flattened_data()
    ])

    back_curve = [(420.0, 232.0)]
    back_curve.extend(cubic_segment((420, 232), (462, 232), (506, 252), (540, 280)))
    back_curve.extend(cubic_segment((540, 280), (548, 288), (554, 296), (560, 300)))
    removal_polygon = [(400, 150), (565, 150), (565, 308)]
    removal_polygon.extend((round(x), round(y)) for x, y in reversed(back_curve))
    ImageDraw.Draw(mask).polygon(removal_polygon, fill=0)
    return mask.filter(ImageFilter.GaussianBlur(0.45))


def add_whale(icon: Image.Image, whale_mask: Image.Image) -> Image.Image:
    whale_glow = Image.new("RGBA", (SIZE, SIZE), (79, 124, 255, 0))
    whale_glow.putalpha(whale_mask.filter(ImageFilter.GaussianBlur(34)).point(lambda value: value // 2))
    icon = Image.alpha_composite(icon, whale_glow)

    whale = Image.new("RGBA", (SIZE, SIZE), (*WHALE_COLOR, 0))
    whale.putalpha(whale_mask)
    return Image.alpha_composite(icon, whale)


def add_terminal_prompt(icon: Image.Image) -> Image.Image:
    symbol_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    rounded_line(
        symbol_glow,
        [(320, 650), (414, 742), (320, 834)],
        86,
        (244, 247, 251, 64),
    )
    ImageDraw.Draw(symbol_glow).rounded_rectangle(
        (462, 792, 704, 850),
        radius=29,
        fill=(244, 247, 251, 54),
    )
    icon = Image.alpha_composite(icon, symbol_glow.filter(ImageFilter.GaussianBlur(22)))

    rounded_line(
        icon,
        [(320, 650), (414, 742), (320, 834)],
        62,
        (244, 247, 251, 255),
    )
    ImageDraw.Draw(icon).rounded_rectangle(
        (462, 792, 704, 850),
        radius=29,
        fill=(128, 161, 255, 255),
    )
    return icon


def add_thought_squares(icon: Image.Image) -> Image.Image:
    squares = [
        (438, 236, 474, 272, 7),
        (486, 184, 536, 234, 10),
        (548, 120, 614, 186, 13),
    ]
    square_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(square_glow)
    for left, top, right, bottom, radius in squares:
        glow_draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=radius,
            fill=(244, 247, 251, 90),
        )
    icon = Image.alpha_composite(icon, square_glow.filter(ImageFilter.GaussianBlur(14)))

    draw = ImageDraw.Draw(icon)
    for left, top, right, bottom, radius in squares:
        draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=radius,
            fill=(244, 247, 251, 255),
        )
    return icon


def generate_icon() -> Image.Image:
    base_icon = Image.open(BASE_ICON).convert("RGBA")
    icon = render_background()
    icon = add_whale(icon, extract_whale_without_fin(base_icon))
    icon = add_terminal_prompt(icon)
    icon = add_thought_squares(icon)
    return icon.crop(ICON_CROP_BOUNDS).resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    icon = generate_icon()
    icon.save(OUTPUT_DIRECTORY / "icon.png", optimize=True)
    icon.save(OUTPUT_DIRECTORY / "icon.icns", format="ICNS")
    icon.save(
        OUTPUT_DIRECTORY / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    icon.save(
        OUTPUT_DIRECTORY / "tray-icon.ico",
        format="ICO",
        sizes=[
            (16, 16),
            (20, 20),
            (24, 24),
            (32, 32),
            (40, 40),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )


if __name__ == "__main__":
    main()
