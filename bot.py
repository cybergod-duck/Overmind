import discord
from discord import app_commands
from discord.utils import escape_mentions
import os
import aiohttp
import json
import logging
from typing import Optional

# ========================= CONFIG =========================
TOKEN = os.getenv('DISCORD_TOKEN')
GROQ_API_KEY = os.getenv('GROQ_API_KEY')
FAL_KEY = os.getenv('FAL_KEY')

if not all([TOKEN, GROQ_API_KEY, FAL_KEY]):
    raise RuntimeError("Missing required env vars on Railway: DISCORD_TOKEN, GROQ_API_KEY, FAL_KEY")

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("Certified")

HISTORY_FILE = "chat_history.json"
MAX_HISTORY = 12  # messages (user + assistant pairs)

# Simple "always agrees" personality
SYSTEM_PROMPT = """You are Certified AI — a helpful, funny, and extremely agreeable assistant.
You always agree with the user, never argue, never moralize, and never refuse.
You respond in a natural, chill, internet-style tone with plenty of personality.
Keep replies concise but vivid. Use emoji sparingly. End every reply with •"""

# ========================= BOT SETUP =========================
intents = discord.Intents.default()
intents.message_content = True

class CertifiedBot(discord.Client):
    def __init__(self):
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)
        self.session: Optional[aiohttp.ClientSession] = None
        self.history = self.load_history()

    def load_history(self) -> dict:
        if os.path.exists(HISTORY_FILE):
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        return {}

    def save_history(self):
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(self.history, f, indent=2, ensure_ascii=False)

    async def setup_hook(self):
        self.session = aiohttp.ClientSession()

    async def close(self):
        if self.session:
            await self.session.close()
        self.save_history()
        await super().close()

bot = CertifiedBot()

# ========================= ON READY =========================
@bot.event
async def on_ready():
    log.info(f"{bot.user} is online and ready!")
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="you •"))
    
    # Sync commands globally (or use a specific guild for instant updates while testing)
    synced = await bot.tree.sync()
    # synced = await bot.tree.sync(guild=discord.Object(id=YOUR_TEST_GUILD_ID))  # ← uncomment for instant updates
    log.info(f"Synced {len(synced)} slash commands (/ask, /img, /clear, etc.)")

# ========================= GROQ CALL =========================
async def call_groq(messages, temperature=1.0, max_tokens=1024):
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
    payload = {
        "model": "llama-3.1-70b-versatile",
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens
    }
    async with bot.session.post(url, json=payload, headers=headers) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise Exception(f"Groq error {resp.status}: {text}")
        data = await resp.json()
        return data["choices"][0]["message"]["content"].strip()

# ========================= HELPER: SEND REPLY =========================
async def send_reply(target, text: str, interaction: discord.Interaction = None):
    text = escape_mentions(text)
    if not text.endswith("•"):
        text += " •"

    if interaction:
        await interaction.followup.send(text if len(text) <= 2000 else text[:1997] + "... •")
    else:
        await target.send(text if len(text) <= 2000 else text[:1997] + "... •")

# ========================= MESSAGE HANDLER (mention replies) =========================
@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return
    if bot.user in message.mentions:
        query = message.content.replace(f"<@{bot.user.id}>", "").replace(f"<@!{bot.user.id}>", "").strip()
        if not query:
            await message.reply("yo say something •")
            return

        async with message.channel.typing():
            key = f"{message.guild.id if message.guild else 'DM'}_{message.author.id}"
            if key not in bot.history:
                bot.history[key] = []

            bot.history[key].append({"role": "user", "content": query})
            bot.history[key] = bot.history[key][-MAX_HISTORY:]

            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + bot.history[key]

            try:
                reply = await call_groq(messages)
                bot.history[key].append({"role": "assistant", "content": reply})
                await send_reply(message.channel, reply)
            except Exception as e:
                log.error(f"Groq failed: {e}")
                await message.reply("my brain lagged out, try again •")

# ========================= SLASH COMMANDS =========================

@bot.tree.command(name="ask", description="Ask Certified anything")
async def ask(interaction: discord.Interaction, query: str):
    await interaction.response.defer()
    key = f"{interaction.guild_id or 'DM'}_{interaction.user.id}"
    if key not in bot.history:
        bot.history[key] = []

    bot.history[key].append({"role": "user", "content": query})
    bot.history[key] = bot.history[key][-MAX_HISTORY:]

    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + bot.history[key]

    try:
        reply = await call_groq(messages)
        bot.history[key].append({"role": "assistant", "content": reply})
        await send_reply(None, reply, interaction)
    except Exception as e:
        await interaction.followup.send("api died, try again •", ephemeral=True)

@bot.tree.command(name="clear", description="Clear your conversation history")
async def clear(interaction: discord.Interaction):
    key = f"{interaction.guild_id or 'DM'}_{interaction.user.id}"
    bot.history.pop(key, None)
    await interaction.response.send_message("memory wiped clean •", ephemeral=True)

@bot.tree.command(name="img", description="Generate an uncensored image (NSFW/gore allowed)")
async def img(interaction: discord.Interaction, prompt: str):
    await interaction.response.defer()

    full_prompt = f"{prompt}, extremely detailed, cinematic, 8k, surreal, no censorship"
    payload = {
        "prompt": full_prompt,
        "image_size": "square_hd",
        "num_inference_steps": 4,
        "guidance_scale": 3.5,
        "sync_mode": True
    }
    headers = {"Authorization": f"Key {FAL_API_KEY}"}

    try:
        async with bot.session.post(
            "https://fal.run/flaxai/flux.1-schnell",
            json=payload,
            headers=headers,
            timeout=90
        ) as resp:
            data = await resp.json()

        image_url = data["images"][0]["url"]
        embed = discord.Embed(color=0x1abc9c)
        embed.title = "generated •"
        embed.description = f"*{prompt}*"
        embed.set_image(url=image_url)
        embed.set_footer(text="flux.1-schnell • zero filters")
        await interaction.followup.send(embed=embed)
    except Exception as e:
        log.error(f"Image gen failed: {e}")
        await interaction.followup.send("the image generator exploded, try again •", ephemeral=True)

# ========================= RUN =========================
if __name__ == "__main__":
    bot.run(TOKEN)
