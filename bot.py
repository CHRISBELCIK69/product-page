# ============================================================
# bot.py
# Discord bot — the customer-facing side of the license-key
# handoff. Runs as its own process (a Railway "worker" service
# using this same repo, not the "web" service that runs server.py).
#
# Talks to server.py only through the /internal/* API (see
# server.py) using INTERNAL_API_SECRET — never touches billing.db
# or Stripe directly, and never holds ACCESS_TOKEN_SECRET.
# ============================================================

import os

import discord
import requests
from discord import app_commands

DISCORD_BOT_TOKEN = os.environ['DISCORD_BOT_TOKEN']
GUILD_ID           = int(os.environ.get('DISCORD_GUILD_ID', '0'))
PAID_ROLE_ID       = int(os.environ.get('DISCORD_PAID_ROLE_ID', '0'))
INTERNAL_API_BASE  = os.environ.get('INTERNAL_API_BASE', 'http://localhost:8000')
INTERNAL_API_SECRET = os.environ['INTERNAL_API_SECRET']
TOOL_BASE_URL      = os.environ.get('TOOL_BASE_URL', 'http://localhost:5000')

intents = discord.Intents.default()
client = discord.Client(intents=intents)
tree = app_commands.CommandTree(client)


def _call_internal(path, payload):
    return requests.post(
        INTERNAL_API_BASE + path,
        json=payload,
        headers={'X-Internal-Secret': INTERNAL_API_SECRET},
        timeout=10,
    )


async def _grant_paid_role(discord_user_id: int):
    guild = client.get_guild(GUILD_ID)
    if not guild or not PAID_ROLE_ID:
        return
    member = guild.get_member(discord_user_id) or await guild.fetch_member(discord_user_id)
    role = guild.get_role(PAID_ROLE_ID)
    if member and role:
        await member.add_roles(role, reason='License key redeemed')


async def _revoke_paid_role(discord_user_id: int):
    guild = client.get_guild(GUILD_ID)
    if not guild or not PAID_ROLE_ID:
        return
    member = guild.get_member(discord_user_id) or await guild.fetch_member(discord_user_id)
    role = guild.get_role(PAID_ROLE_ID)
    if member and role and role in member.roles:
        await member.remove_roles(role, reason='Subscription no longer active')


@tree.command(name='redeem', description='Link your subscription with the license key from checkout')
@app_commands.describe(key='The VTX-XXXXXXXX key shown after you subscribed')
async def redeem(interaction: discord.Interaction, key: str):
    await interaction.response.defer(ephemeral=True)

    try:
        r = _call_internal('/internal/redeem-license', {
            'license_key': key.strip(),
            'discord_user_id': str(interaction.user.id),
        })
    except requests.RequestException:
        await interaction.followup.send(
            "Couldn't reach the billing service — try again in a moment.", ephemeral=True)
        return

    if r.status_code != 200:
        message = (r.json() or {}).get('error', 'That license key is invalid.')
        await interaction.followup.send(f"{message}", ephemeral=True)
        return

    await _grant_paid_role(interaction.user.id)
    await interaction.followup.send(
        "You're linked! Run /tool any time to get a link into the backtester.", ephemeral=True)


@tree.command(name='tool', description='Get a link into the backtester')
async def tool(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)

    try:
        status_r = _call_internal('/internal/subscriber-status', {'discord_user_id': str(interaction.user.id)})
    except requests.RequestException:
        await interaction.followup.send(
            "Couldn't reach the billing service — try again in a moment.", ephemeral=True)
        return

    if status_r.status_code != 200 or not status_r.json().get('active'):
        await _revoke_paid_role(interaction.user.id)
        await interaction.followup.send(
            "No active subscription linked to your Discord account. "
            "Run /redeem <key> first, or subscribe from the product page.", ephemeral=True)
        return

    token_r = _call_internal('/internal/mint-access-token', {'discord_user_id': str(interaction.user.id)})
    if token_r.status_code != 200:
        await interaction.followup.send("Couldn't generate an access link — try again in a moment.", ephemeral=True)
        return

    url = f"{TOOL_BASE_URL}/?access={token_r.json()['token']}"
    view = discord.ui.View()
    view.add_item(discord.ui.Button(label='Open Tool', url=url, style=discord.ButtonStyle.link))
    await interaction.followup.send("Here's your link — expires in 15 minutes:", view=view, ephemeral=True)


@client.event
async def on_ready():
    guild_obj = discord.Object(id=GUILD_ID) if GUILD_ID else None
    await tree.sync(guild=guild_obj)
    print(f'Bot ready as {client.user}')


if __name__ == '__main__':
    client.run(DISCORD_BOT_TOKEN)
