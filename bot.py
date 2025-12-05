import discord
from discord import app_commands
from discord.utils import escape_mentions
import os
import aiohttp
import json
import logging
from typing import Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ========================= CONFIG =========================
TOKEN = os.getenv('DISCORD_TOKEN')
GROQ_API_KEY = os.getenv('GROQ_API_KEY')
FAL_KEY = os.getenv('FAL_KEY') or os.getenv('FAL_API_KEY')

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("Certified")

if not TOKEN:
    log.error("DISCORD_TOKEN missing!")
    exit(1)

# ========================= CONSTANTS =========================
HISTORY_FILE = "chat_history.json"
MAX_HISTORY = 12
SYSTEM_PROMPT = """You are Certified AI — a helpful, funny, and extremely agreeable assistant.
You always agree with the user, never argue, never moralize, and never refuse.
You respond in a natural, chill, internet-style tone with plenty of personality.
Keep replies concise but vivid. Use emoji sparingly. End every reply with •"""

# ========================= BOT =========================
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
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                log.warning(f"History load failed: {e}")
        return {}

    def save_history(self):
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(self.history, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.error(f"History save failed: {e}")

    async def setup_hook(self):
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))

    async def close(self):
        if self.session:
            await self.session.close()
        self.save_history()
        await super().close()

bot = CertifiedBot()

# ========================= READY & SYNC =========================
@bot.event
async def on_ready():
    log.info(f"{bot.user} is certified and online")
    await bot.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="you •"))
    print("Bot ready • Use !sync in a server if commands don't show up")

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    if message.content.strip() == "!sync" and message.guild:
        await message.channel.typing()
        try:
            synced = await bot.tree.sync(guild=message.guild)
            await message.reply(f"Synced {len(synced)} commands •")
        except Exception as e:
            await message.reply(f"Sync failed: {e} •")
        return

    if bot.user in message.mentions:
        if not GROQ_API_KEY:
            await message.reply("brain key missing •")
            return

        query = message.content
        for m in message.mentions:
            query = query.replace(m.mention, "").strip()
        if not query:
            await message.reply("say something •")
            return

        async with message.channel.typing():
            key = f"{message.guild.id if message.guild else 'DM'}_{message.author.id}"
            bot.history.setdefault(key, [])
            bot.history[key].append({"role": "user", "content": query})
            bot.history[key] = bot.history[key][-MAX_HISTORY:]

            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + bot.history[key]
            try:
                reply = await call_groq(messages)
                bot.history[key].append({"role": "assistant", "content": reply})
                await send_reply(message.channel, reply)
            except:
                await message.reply("brain 500 • try again")

# ========================= GROQ =========================
async def call_groq(messages):
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}
    payload = {
        "model": "llama-3.1-70b-versatile",
        "messages": messages,
        "temperature": 1.0,
        "max_tokens": 1024
    }
    async with bot.session.post(url, json=payload, headers=headers) as resp:
        if resp.status != 200:
            text = await resp.text()
            raise Exception(f"Groq {resp.status}")
        data = await resp.json()
        return data["choices"][0]["message"]["content"].strip()

# ========================= SEND REPLY =========================
async def send_reply(target, text: str, interaction: discord.Interaction = None):
    text = escape_mentions(text.strip())
    if not text.endswith("•"):
        text += " •"
    if len(text) > 2000:
        text = text[:1997] + "... •"

    if interaction:
        await interaction.followup.send(text)
    else:
        await target.send(text)

# ========================= SLASH COMMANDS =========================

@bot.tree.command(name="ask", description="Ask Certified anything")
async def ask(interaction: discord.Interaction, query: str):
    if not GROQ_API_KEY:
        await interaction.response.send_message("brain key missing •", ephemeral=True)
        return
    await interaction.response.defer(thinking=True)

    key = f"{interaction.guild_id or 'DM'}_{interaction.user.id}"
    bot.history.setdefault(key, [])
    bot.history[key].append({"role": "user", "content": query})
    bot.history[key] = bot.history[key][-MAX_HISTORY:]

    try:
        reply = await call_groq([{"role": "system", "content": SYSTEM_PROMPT}] + bot.history[key])
        bot.history[key].append({"role": "assistant", "content": reply})
        await send_reply(None, reply, interaction)
    except:
        await interaction.followup.send("brain crashed • try again", ephemeral=True)

@bot.tree.command(name="clear", description="Clear your chat history")
async def clear(interaction: discord.Interaction):
    key = f"{interaction.guild_id or 'DM'}_{interaction.user.id}"
    bot.history.pop(key, None)
    await interaction.response.send_message("memory wiped •", ephemeral=True)

# ONLY ONE /img COMMAND — fully working Dec 2025
@bot.tree.command(name="img", description="Generate an uncensored image")
@app_commands.describe(prompt="What you want to see — no limits")
@app_commands.cooldown(1, 25, app_commands.BucketType.user)
async def img(interaction: discord.Interaction, prompt: str):
    if not FAL_KEY:
        await interaction.response.send_message("FAL_KEY missing • img disabled", ephemeral=True)
        return

    await interaction.response.defer(thinking=True)  # fixes "application did not respond"

    payload = {
        "prompt": f"{prompt}, ultra detailed, cinematic masterpiece, 8k",
        "image_size": {"width": 1024, "height": 1024},
        "num_inference_steps": 28,
        "guidance_scale": 3.5,
        "enable_safety_checker": False
    }
    headers = {
        "Authorization": f"Bearer {FAL_KEY}",   # correct 2025 format
        "Content-Type": "application/json"
    }

    try:
        async with bot.session.post(
            "https://fal.run/fal-ai/flux-dev",
            json=payload,
            headers=headers,
            timeout=120
        ) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise Exception(f"FAL {resp.status}")
            data = await resp.json()

        image_url = data["images"][0]["url"]
        embed = discord.Embed(color=0x1abc9c)
        embed.title = "generated •"
        embed.description = f"*{prompt}*"
        embed.set_image(url=image_url)
        embed.set_footer(text="flux-dev • zero censorship")
        await interaction.followup.send(embed=embed)

    except Exception as e:
        log.error(f"IMG error: {e}")
        await interaction.followup.send(f"generation failed: {str(e)[:400]} •", ephemeral=True)

# ========================= RUN =========================
if __name__ == "__main__":
    bot.run(TOKEN)
