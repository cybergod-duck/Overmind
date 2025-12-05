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
@tree.command(name="img", description="NSFW god-tier image (SinkIn)")
async def img(interaction: discord.Interaction, prompt: str):
    await interaction.response.defer(thinking=True)

    try:
        async with session.post(
            "https://sinkin.ai/m/v1/sd_xl",
            json={
                "prompt": f"{prompt}, masterpiece, best quality, ultra-detailed, beautiful face, perfect body, nsfw",
                "negative_prompt": "blurry, ugly, deformed, censorship",
                "width": 1024,
                "height": 1024,
                "num_inference_steps": 30,
                "guidance_scale": 7.5
            },
            timeout=180
        ) as r:
            data = await r.json()

        url = data["images"][0]
        embed = discord.Embed(color=0x1abc9c)
        embed.title = "generated •"
        embed.set_image(url=url)
        embed.set_footer(text="SinkIn XL • full nsfw")
        await interaction.followup.send(embed=embed)

    except Exception as e:
        await interaction.followup.send("sinkin died • try again", ephemeral=True)
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
