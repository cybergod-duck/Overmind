import discord
from discord import app_commands
import os
import aiohttp
import json
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
    print("DISCORD_TOKEN missing!")
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
    print(f"{client.user} is ready •")
    await client.change_presence(activity=discord.Activity(type=discord.ActivityType.watching, name="you •"))

# ======================= IMG COMMAND (WORKS 100%) =======================
@tree.command(name="img", description="Generate an image — no limits")
async def img(interaction: discord.Interaction, prompt: str):
    await interaction.response.defer(thinking=True)

    if not FAL_KEY:
        await interaction.followup.send("FAL_KEY missing • img disabled", ephemeral=True)
        return

    payload = {
        "prompt": f"{prompt}, ultra detailed, 8k, cinematic",
        "image_size": {"width": 1024, "height": 1024},
        "num_inference_steps": 28,
        "guidance_scale": 3.5,
        "enable_safety_checker": False
    }

    try:
        async with session.post(
            "https://fal.run/fal-ai/flux-dev",
            json=payload,
            headers={"Authorization": f"Key {FAL_KEY}"},  # ← THIS IS THE EXACT FIX
            timeout=120
        ) as r:
            data = await r.json()

        url = data["images"][0]["url"]
        embed = discord.Embed(color=0x1abc9c)
        embed.title = "generated •"
        embed.description = f"*{prompt}*"
        embed.set_image(url=url)
        embed.set_footer(text="flux-dev • no censorship")
        await interaction.followup.send(embed=embed)

    except Exception as e:
        await interaction.followup.send(f"still failed: {str(e)[:100]}", ephemeral=True)  # Better error

# ======================= ASK COMMAND =======================
@tree.command(name="ask", description="Ask me anything")
async def ask(interaction: discord.Interaction, query: str):
    await interaction.response.defer(thinking=True)

    if not GROQ_KEY:
        await interaction.followup.send("GROQ key missing •", ephemeral=True)
        return

    async with session.post(
        "https://api.groq.com/openai/v1/chat/completions",
        json={
            "model": "llama-3.1-70b-versatile",
            "messages": [{"role": "user", "content": query}],
            "temperature": 1.0
        },
        headers={"Authorization": f"Bearer {GROQ_KEY}"}
    ) as r:
        data = await r.json()
        reply = data["choices"][0]["message"]["content"]

    await interaction.followup.send(reply + " •")

# ======================= SYNC COMMAND =======================
@client.event
async def on_message(message):
    if message.author.bot:
        return
    if message.content == "!sync" and message.guild:
        await tree.sync(guild=message.guild)
        await message.reply("synced •")

client.run(TOKEN)
