from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random
lines = ["Turi @ Ocean", "1. Touch up paint master bath", "2. Replace cracked tile by back door",
         "3. Caulk kitchen backsplash", "4. Adjust closet doors upstairs", "5. Install outlet covers garage"]
fonts = {"neat": "/usr/share/fonts/truetype/sand-box/google/Kalam/Kalam-Regular.ttf",
         "messy": "/usr/share/fonts/truetype/sand-box/google/Caveat/Caveat-VariableFont_wght.ttf"}
random.seed(3)
for name, fp in fonts.items():
    W, H = 1200, 1500
    im = Image.new("RGB", (W, H), "#fbf8ee"); d = ImageDraw.Draw(im)
    for y in range(160, H, 90): d.line([(40, y + 60), (W - 40, y + 60)], fill="#b9cde6", width=2)  # ruled paper
    f = ImageFont.truetype(fp, 64 if name == "neat" else 76)
    y = 150
    for i, l in enumerate(lines):
        d.text((80 + random.randint(-8, 8), y), l, font=f, fill="#1a2a6c")
        y += 180 if i == 0 else 90
    im = im.rotate(1.5, expand=False, fillcolor="#fbf8ee").filter(ImageFilter.GaussianBlur(0.6))
    im.save(f"samples/{name}.jpg", quality=85)
print("ok")
