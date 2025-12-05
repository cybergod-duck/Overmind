import discord
from discord import app_commands
import os
import aiohttp
import logging

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

TOKEN   = os.getenv("DISCORD_TOKEN")
GROQ_KEY = os.getenv("GROQ_API_KEY")
FAL_KEY  = os.getenv("FAL_KEY") or os.getenv("FAL_API_KEY")

if not TOKEN:
    print("No DISCORD_TOKEN → exiting")
    exit()

intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)
session = None

@client.event
async def on_ready():
    global session
    session = aiohttp.ClientSession()
    print(f"{client.user} ready •")
    await client.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="you •"))

# ======================= IMG — FIXED ENDPOINT =======================
@tree.command(name="img", description="Generate uncensored image")
async def img(interaction: discord.Interaction, prompt: str):
    await interaction.response.defer(thinking=True)

    if not FAL_KEY:
        await interaction.followup.send("FAL_KEY missing", ephemeral=True)
        return

    payload = {
        "prompt": f"{prompt}, ultra detailed, cinematic, 8k",
        "image_size": {"width": 1024, "height": 1024},
        "num_inference_steps": 28,
        "guidance_scale": 3.5,
        "enable_safety_checker": False
    }

    try:
        async with session.post(
            "https://fal.run/fal-ai/flux/dev",  # ← CORRECT 2025 ENDPOINT
            json=payload,
            headers={"Authorization": f"Key {FAL_KEY}"},
            timeout=120
        ) as r:
            if r.status != 200:
                text = await r.text()
                raise Exception(f"FAL {r.status}: {text[:100]}")
            data = await r.json()

        url = data["images"][0]["url"]
        embed = discord.Embed(color=0x1abc9c)
        embed.title = "generated •"
        embed.description = f"*{prompt}*"
        embed.set_image(url=url)
        embed.set_footer(text="flux/dev • uncensored")
        await interaction.followup.send(embed=embed)

    except Exception as e:
        await interaction.followup.send(f"failed: {str(e)[:200]}", ephemeral=True)

# ======================= ASK =======================
@tree.command(name="ask", description="Ask me anything")
async def ask(interaction: discord.Interaction, query: str):
    await interaction.response.defer(thinking=True)
    if not GROQ_KEY:
        await interaction.followup.send("no groq key", ephemeral=True)
        return
    async with session.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json={"model": "llama-3.1-70b-versatile", "messages": [{"role": "user", "content": query}]},
        headers={"Authorization": f"Bearer {GROQ_KEY}"}
    ) as r:
        data = await r.json()
        reply = data["choices"][0]["message"]["content"]
    await interaction.followup.send(reply + " •")

# ======================= SYNC =======================
@client.event
async def on_message(message):
    if message.author.bot: return
    if message.content == "!sync" and message.guild:
        await tree.sync(guild=message.guild)
        await message.reply("synced •")

client.run(TOKEN)
