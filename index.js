require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus
} = require("@discordjs/voice");
const YTDlpWrap = require("yt-dlp-wrap").default;
const { spawn } = require("child_process");

const ytDlp = new YTDlpWrap();

// Cola por servidor
const queues = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("clientReady", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

// Función para reproducir la canción actual de la cola
async function playNext(guildId, channel) {
  const queue = queues.get(guildId);
  if(!queue) return;
  if (queue.songs.length === 0) return;

  const song = queue.songs[queue.index];
  if (!song) {
    channel.send("🆙 No hay mas canciones en la cola. Usa `!stop` para desconectarme.");
    return;
  }

  try {
    const audioUrl = await ytDlp.execPromise([
      song.url,
      "--get-url",
      "--extractor-args", "youtube:player_client=tv_embedded",
      "-f", "bestaudio"
    ]);

    const url = audioUrl.trim().split("\n")[0];

    const ffmpegProcess = spawn("ffmpeg", [
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", url,
      "-analyzeduration", "0",
      "-loglevel", "0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1"
    ]);

    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.Raw
    });

    queue.player.play(resource);
    queue.currentProcess = ffmpegProcess;

    const loopindicator = queue.loop === "song" ? "🔂" : queue.loop === "queue" ? " 🔁" : "";
    channel.send(`🎵 Reproduciendo: **${song.title}**${loopindicator}`);

    queue.player.once(AudioPlayerStatus.Idle, () => {
      if (queue.loop === "song") {
        // Repetir misma cancion
      playNext(guildId, channel);
      } else if (queue.loop === "queue") {
        // Avanzar y volver al inicio si llega al final
        queue.index = (queue.index + 1) % queue.songs.length;
        playNext(guildId, channel);
      } else {
        queue.index++;
        if (queue.index >= queue.songs.length) {
          queue.index = 0;
          queue.songs = [];
          channel.send("🆙 No hay mas Canciones en la Cola. Usa !stop para desconectarme.");
          return;
        }
        playNext(guildId, channel);
      } 
    });

  } catch (err) {
    console.error(err);
    channel.send("❌ Error al reproducir, pasando a la siguiente...");
    queue.index++;
    playNext(guildId, channel);
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const prefix = "!";
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(" ");
  const command = args.shift().toLowerCase();
  const query = args.join(" ").trim();

  const guildId = message.guild.id;

  // ── !play ──────────────────────────────────────────
  if (command === "play") {
    if (!query) return message.reply("❌ Escribe una canción, URL o playlist.");

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply("❌ Entra a un canal de voz primero.");

    await message.reply("🔍 Buscando...");

    try {
      let songs = [];

      // Detectar si es playlist de YouTube
      const isPlaylist = query.includes("list=");
      const isUrl = query.startsWith("http");

      if (isPlaylist) {
        // Obtener todas las canciones de la playlist
        const info = await ytDlp.execPromise([
          query,
          "--flat-playlist",
          "--print", "%(url)s|||%(title)s",
          "--extractor-args", "youtube:player_client=tv_embedded"
        ]);

        songs = info.trim().split("\n").map(line => {
          const [id, title] = line.split("|||");
          // Si ya es URL completa, usarla directamente, si no, construirla
          const url = id.startsWith("http") ? id : `https://www.youtube.com/watch?v=${id}`;
          return { url, title: title || id };
        });

        message.channel.send(`📋 Playlist agregada: **${songs.length} canciones**`);

      } else {
        // Una sola canción o búsqueda
        const searchQuery = isUrl ? query : `ytsearch1:${query}`;
        const titleInfo = await ytDlp.execPromise([
          searchQuery,
          "--get-title",
          "--extractor-args", "youtube:player_client=tv_embedded",
          "--no-playlist"
        ]);
        const urlInfo = await ytDlp.execPromise([
          searchQuery,
          "--get-id",
          "--extractor-args", "youtube:player_client=tv_embedded",
          "--no-playlist"
        ]);

        const title =titleInfo.trim().split("\n")[0] || query;
        const videoId = urlInfo.trim().split("\n")[0];
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        songs = [{ url, title }];
      }

      // Crear o usar cola existente
      if (!queues.has(guildId)) {
        const player = createAudioPlayer();
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator
        });
        connection.subscribe(player);

        queues.set(guildId, {
          songs,
          index: 0,
          player,
          connection,
          paused: false,
          history: [],
          loop: "none",
          volume: 1.0
        });

        playNext(guildId, message.channel);
      } else {
        const queue = queues.get(guildId);
        queue.songs.push(...songs);
        message.channel.send(`➕ Agregado a la cola: **${songs.length === 1 ? songs[0].title : songs.length + " canciones"}**`);
        if (queue.songs.length === songs.length) {
          playNext(guildId, message.channel);
        }
      }

    } catch (err) {
      console.error(err);
      message.channel.send("❌ Error al buscar la canción.");
    }
  }

  // ── !pause ─────────────────────────────────────────
  else if (command === "pause") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    if (queue.paused) {
      queue.player.unpause();
      queue.paused = false;
      message.reply("▶️ Reanudado.");
    } else {
      queue.player.pause();
      queue.paused = true;
      message.reply("⏸️ Pausado.");
    }
  }

  // ── !skip ──────────────────────────────────────────
  else if (command === "skip") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.index++;
    queue.player.stop();
    message.reply("⏭️ Saltando...");
    playNext(guildId, message.channel);
  }

  // ── !prev ──────────────────────────────────────────
  else if (command === "prev") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    if (queue.index <= 0) return message.reply("❌ No hay canción anterior.");

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.index--;
    queue.player.stop();
    message.reply("⏮️ Volviendo a la anterior...");
    playNext(guildId, message.channel);
  }

  // ── !stop ──────────────────────────────────────────
  else if (command === "stop") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ El bot no esta conectado.");

    if (queue.songs.length > 0) {
      return message.reply("🧹 Debes limpiar la cola antes de desconectar el bot. Usa `!clean` para limpiarla.");
    }

    queue.player.stop();
    queue.connection.destroy();
    queues.delete(guildId);
    message.reply("⏹️ Bot desconectado.");
  }

  // ── !clean ──────────────────────────────────────────
  else if (command === "clean") {
  const queue = queues.get(guildId);
  if (!queue) return message.reply("❌ No hay nada en cola.");

  queue.player.removeAllListeners(AudioPlayerStatus.Idle);
  queue.player.stop();
  queue.songs = [];
  queue.index = 0;
  message.reply("✅ Cola limpiada. Ahora puedes usar `!stop` para desconectar el bot.");
}

  // ── !queue ─────────────────────────────────────────
  else if (command === "colas") {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) return message.reply("❌ La cola está vacía.");

    const list = queue.songs
      .slice(queue.index, queue.index + 10)
      .map((s, i) => `${i === 0 ? "▶️" : `${queue.index + i + 1}.`} ${s.title}`)
      .join("\n");

    message.reply(`🎵 **Cola actual:**\n${list}`);
  }

  // ── !loop ──────────────────────────────────────────
  else if (command === "loop") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    const modes = ["none", "song", "queue"];
    const labels = { none: "desactivado", song: "🔂 canción", queue: "🔁 cola" };

    // Rotar entre modos
    const currentIndex = modes.indexOf(queue.loop);
    queue.loop = modes[(currentIndex + 1) % modes.length];

    message.reply(`Loop ${labels[queue.loop]}.`);
  }

  // ── !volume ────────────────────────────────────────
  else if (command === "volume") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 1 || vol > 200) {
      return message.reply(`🔊 Volumen actual: **${Math.round(queue.volume * 100)}%**\nUso: \`!volume 1-200\``);
    }

    queue.volume = vol / 100;
    message.reply(`🔊 Volumen ajustado a **${vol}%**. Tomará efecto en la siguiente canción.`);
  }

  // ── !shuffle ───────────────────────────────────────
  else if (command === "shuffle") {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) return message.reply("❌ La cola está vacía.");

    // Mezclar solo las canciones que faltan por reproducir
    const played = queue.songs.slice(0, queue.index + 1);
    const remaining = queue.songs.slice(queue.index + 1);

    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    queue.songs = [...played, ...remaining];
    message.reply("🔀 Cola mezclada!");
  }

  // ── !nowplaying ────────────────────────────────────
  else if (command === "nowplaying" || command === "np") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("❌ No hay música reproduciéndose.");

    const song = queue.songs[queue.index];
    if (!song) return message.reply("❌ No hay canción actual.");

    const loopStatus = queue.loop === "song" ? "🔂 Canción" : queue.loop === "queue" ? "🔁 Cola" : "❌";

    message.reply(`
🎵 **Reproduciendo ahora:**
**${song.title}**
🔊 Volumen: ${Math.round(queue.volume * 100)}%
🔁 Loop: ${loopStatus}
📋 Posición en cola: ${queue.index + 1}/${queue.songs.length}
    `);
  }


  // ── !help ──────────────────────────────────────────
  else if (command === "help") {
    message.reply(`
🎵 **Comandos de MORFEO:**
\`!play <canción/URL/playlist>\` — Reproducir o agregar a la cola
\`!pause\` — Pausar/reanudar
\`!skip\` — Saltar a la siguiente
\`!prev\` — Volver a la anterior
\`!stop\` — Desconectar
\`!clean\` — Limpiar La Colas
\`!colas\` — Ver la cola actual
\`!loop\` — Cambiar modo de repetición (ninguno/canción/cola)
\`!shuffle\` — Mezclar la cola
\`!volume <1-200>\` — Ajustar volumen
\`!nowplaying\` o \`!np\` — Ver canción actual
\`!help\` — Ver esta lista
    `);
  }
});

client.login(process.env.TOKEN);