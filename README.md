# yabb - yet another bridge, bb 👶

```
                     __        __       
                    /  |      /  |      
 __    __   ______  $$ |____  $$ |____  
/  |  /  | /      \ $$      \ $$      \ 
$$ |  $$ | $$$$$$  |$$$$$$$  |$$$$$$$  |
$$ |  $$ | /    $$ |$$ |  $$ |$$ |  $$ |
$$ \__$$ |/$$$$$$$ |$$ |__$$ |$$ |__$$ |
$$    $$ |$$    $$ |$$    $$/ $$    $$/ 
 $$$$$$$ | $$$$$$$/ $$$$$$$/  $$$$$$$/  
/  \__$$ |                              
$$    $$/                               
 $$$$$$/                                

```

> A utility to bridge Discord channels/chats and Telegram groups/group threads.

---

## Setup

After cloning the repo:

```sh
cp .env.example .env  # and edit to fill in your details
cp example.config.yml config.yml  # and edit to fill in your details
```

&nbsp;

**To create a Discord application/bot:**

Visit the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.

Then:

* Installation: Disable install link
* OAuth2: Generate a link to invite to your own guild by checking off "Bot" and then "Administrator"
    * Add the bot to your server using this link
* Bot:
    * **Uncheck** Public Bot
    * **Check** Message Content Intent (so that it can read messages)
    * **Reset** token; save this value in your .env file under the `DISCORD_BOT_TOKEN` variable

&nbsp;

**To create a Telegram bot:**

Message [@BotFather](https://t.me/BotFather) to create a new bot. Set the details to your preference.

Then:

* Set bot privacy so that it can listen to all messages
    1. /setprivacy
    2. Select your bridge bot
    3. Select "Disable" option
* Copy the bot token; save this value in your .env file under the `TELEGRAM_BOT_TOKEN` variable
* Add the bot to your Telegram group(s)

&nbsp;

**To map channels between platforms:**

Edit `config.yml` and add an entry for each channel mapping you would like to use. To get channel IDs:

| Platform | Instructions | Example |
| - | - | - |
| Discord | Right click the channel and select "Copy Channel ID" (enable Developer Settings if you do not see this) | `123456789012345678` |
| Telegram | Right click on any message in your group chat and select "Copy Message Link". The format will be either: `https://t.me/c/<chat_id>/<message_id>` or `https://t.me/c/<chat_id>/<thread_id>/<message_id>`. If you do not have a `thread_id` or the `thread_id` is `1`, you only need the `chat_id`, else be sure to use the thread id in the mapping config's `telegram_thread_id` field. Final note: prefix the chat ID with `-100`. | `-1009876543210` |

See [`example.config.yml`](./example.config.yml) for reference.

&nbsp;

## Orphaned message cleanup

Telegram does not notify bots when a message is deleted, so if someone deletes a message on the Telegram side the mirrored Discord message will remain. The optional cleanup feature periodically scans recent bridged messages, probes whether the original Telegram message still exists, and deletes any Discord mirrors whose originals are gone.

**How the probe works:** the bot forwards each Telegram message to a designated private "sink" group to test existence, then immediately deletes the probe forward. If the forward fails (message no longer exists), the Discord mirror is cleaned up. This means you need a dedicated private Telegram group that only the bot is a member of.

**Setup:**

1. Create a new private Telegram group.
2. Add your bridge bot to it.
3. Get the group's chat ID (e.g. forward any message in it to [@userinfobot](https://t.me/userinfobot), or temporarily enable debug logging).
4. Set the following variables in your `.env`:

```sh
CLEANUP_SINK_CHAT_ID=-100xxxxxxxxxxx  # chat ID of the private sink group
CLEANUP_SINK_THREAD_ID=123            # optional: topic/thread ID within the sink group, if using threads
CLEANUP_INTERVAL_MINUTES=15           # how often to run (default: 15)
CLEANUP_LOOKBACK=50                   # messages per bridge to check each run (default: 50)
```

If `CLEANUP_SINK_CHAT_ID` is not set, the feature is fully disabled and no probing occurs.

&nbsp;

## Running

```sh
docker compose up -d
```
