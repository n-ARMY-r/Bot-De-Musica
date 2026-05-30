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
const SpotifyWebApi = require("spotify-web-api-node");

const ytDlp = new YTDlpWrap();

// Configurar Spotify
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET
});

// Obtener token de Spotify automaticamente
async function refreshSpotifyToken() {
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  // Refrescar cada 50 minutos
  setTimeout(refreshSpotifyToken, 50 * 60 * 1000);
}
refreshSpotifyToken();

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
  console.log(`Bot Spotify conectado como ${client.user.tag}`);
});

async function playNext(guildId, channel) {
  const queue = queues.get(guildId);
  if (!queue) return;
  if (queue.songs.length === 0) return;

  const song = queue.songs[queue.index];
  if (!song) {
    channel.send("No hay mas canciones en la cola. Usa !stop para desconectarme.");
    return;
  }

  try {
    // Buscar en YouTube por titulo y artista
    const searchQuery = `ytsearch1:${song.title} ${song.artist}`;

    const audioUrl = await ytDlp.execPromise([
      searchQuery,
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
      "-filter:a", `volume=${queue.volume}`,
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

    const loopIndicator = queue.loop === "song" ? " 🔂" : queue.loop === "queue" ? " 🔁" : "";
    channel.send(`🎵 Reproduciendo: **${song.title}** - ${song.artist}${loopIndicator}`);

    queue.player.once(AudioPlayerStatus.Idle, () => {
      if (queue.loop === "song") {
        playNext(guildId, channel);
      } else if (queue.loop === "queue") {
        queue.index = (queue.index + 1) % queue.songs.length;
        playNext(guildId, channel);
      } else {
        queue.index++;
        if (queue.index >= queue.songs.length) {
          queue.index = 0;
          queue.songs = [];
          channel.send("No hay mas canciones en la cola. Usa !stop para desconectarme.");
          return;
        }
        playNext(guildId, channel);
      }
    });

  } catch (err) {
    console.error(err);
    channel.send("Error al reproducir, pasando a la siguiente...");
    queue.index++;
    playNext(guildId, channel);
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const prefix = "!s";
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(" ");
  const command = args.shift().toLowerCase();
  const query = args.join(" ").trim();

  const guildId = message.guild.id;

  // ── !splay ─────────────────────────────────────────
  if (command === "play") {
    if (!query) return message.reply("Escribe una cancion o link de Spotify.");

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply("Entra a un canal de voz primero.");

    await message.reply("🔍 Buscando en Spotify...");

    try {
      let songs = [];

      // Detectar si es link de Spotify
      if (query.includes("spotify.com/track")) {
        // Cancion individual
        const trackId = query.split("track/")[1].split("?")[0];
        const track = await spotifyApi.getTrack(trackId);
        songs = [{
          title: track.body.name,
          artist: track.body.artists[0].name
        }];

      } else if (query.includes("spotify.com/playlist")) {
        // Playlist de Spotify
        const playlistId = query.split("playlist/")[1].split("?")[0];
        const playlist = await spotifyApi.getPlaylist(playlistId);
        const items = playlist.body.tracks.items;

        songs = items
          .filter(item => item.track)
          .map(item => ({
            title: item.track.name,
            artist: item.track.artists[0].name
          }));

        message.channel.send(`📋 Playlist de Spotify agregada: **${songs.length} canciones**`);

      } else if (query.includes("spotify.com/album")) {
        // Album de Spotify
        const albumId = query.split("album/")[1].split("?")[0];
        const album = await spotifyApi.getAlbum(albumId);
        const items = album.body.tracks.items;

        songs = items.map(track => ({
          title: track.name,
          artist: track.artists[0].name
        }));

        message.channel.send(`💿 Album agregado: **${songs.length} canciones**`);

      } else {
        // Buscar por nombre en Spotify
        const results = await spotifyApi.searchTracks(query, { limit: 1 });
        if (!results.body.tracks.items.length) {
          return message.channel.send("No encontre nada en Spotify.");
        }
        const track = results.body.tracks.items[0];
        songs = [{
          title: track.name,
          artist: track.artists[0].name
        }];
      }

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
          loop: "none",
          volume: 1.0
        });

        playNext(guildId, message.channel);
      } else {
        const queue = queues.get(guildId);
        queue.songs.push(...songs);
        message.channel.send(`➕ Agregado a la cola: **${songs.length === 1 ? `${songs[0].title} - ${songs[0].artist}` : songs.length + " canciones"}**`);
        if (queue.songs.length === songs.length) {
          playNext(guildId, message.channel);
        }
      }

    } catch (err) {
      console.error(err);
      message.channel.send("Error al buscar en Spotify.");
    }
  }

  // ── !spause ────────────────────────────────────────
  else if (command === "pause") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

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

  // ── !sskip ─────────────────────────────────────────
  else if (command === "skip") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.index++;
    queue.player.stop();
    message.reply("⏭️ Saltando...");
    playNext(guildId, message.channel);
  }

  // ── !sprev ─────────────────────────────────────────
  else if (command === "prev") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

    if (queue.index <= 0) return message.reply("No hay cancion anterior.");

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.index--;
    queue.player.stop();
    message.reply("⏮️ Volviendo a la anterior...");
    playNext(guildId, message.channel);
  }

  // ── !sstop ─────────────────────────────────────────
  else if (command === "stop") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("El bot no esta conectado.");

    if (queue.songs.length > 0) {
      return message.reply("Debes limpiar la cola antes de desconectar. Usa !sclean.");
    }

    queue.player.stop();
    queue.connection.destroy();
    queues.delete(guildId);
    message.reply("Bot desconectado.");
  }

  // ── !sclean ────────────────────────────────────────
  else if (command === "clean") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay nada en cola.");

    queue.player.removeAllListeners(AudioPlayerStatus.Idle);
    queue.player.stop();
    queue.songs = [];
    queue.index = 0;
    message.reply("Cola limpiada. Ahora puedes usar !sstop para desconectarme.");
  }

  // ── !scolas ────────────────────────────────────────
  else if (command === "colas") {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) return message.reply("La cola esta vacia.");

    const list = queue.songs
      .slice(queue.index, queue.index + 10)
      .map((s, i) => `${i === 0 ? "▶️" : `${queue.index + i + 1}.`} ${s.title} - ${s.artist}`)
      .join("\n");

    message.reply(`🎵 Cola actual:\n${list}`);
  }

  // ── !sloop ─────────────────────────────────────────
  else if (command === "loop") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

    const modes = ["none", "song", "queue"];
    const labels = { none: "desactivado", song: "🔂 cancion", queue: "🔁 cola" };

    const currentIndex = modes.indexOf(queue.loop);
    queue.loop = modes[(currentIndex + 1) % modes.length];

    message.reply(`Loop: ${labels[queue.loop]}`);
  }

  // ── !svolume ───────────────────────────────────────
  else if (command === "volume") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 1 || vol > 200) {
      return message.reply(`Volumen actual: ${Math.round(queue.volume * 100)}%\nUso: !svolume 1-200`);
    }

    queue.volume = vol / 100;
    message.reply(`🔊 Volumen ajustado a ${vol}%. Tomara efecto en la siguiente cancion.`);
  }

  // ── !sshuffle ──────────────────────────────────────
  else if (command === "shuffle") {
    const queue = queues.get(guildId);
    if (!queue || queue.songs.length === 0) return message.reply("La cola esta vacia.");

    const played = queue.songs.slice(0, queue.index + 1);
    const remaining = queue.songs.slice(queue.index + 1);

    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    queue.songs = [...played, ...remaining];
    message.reply("🔀 Cola mezclada!");
  }

  // ── !snp ──────────────────────────────────────────
  else if (command === "np" || command === "nowplaying") {
    const queue = queues.get(guildId);
    if (!queue) return message.reply("No hay musica reproduciendose.");

    const song = queue.songs[queue.index];
    if (!song) return message.reply("No hay cancion actual.");

    const loopStatus = queue.loop === "song" ? "🔂 Cancion" : queue.loop === "queue" ? "🔁 Cola" : "No";

    message.reply(`🎵 Reproduciendo ahora:\n**${song.title}** - ${song.artist}\nVolumen: ${Math.round(queue.volume * 100)}%\nLoop: ${loopStatus}\nPosicion en cola: ${queue.index + 1}/${queue.songs.length}`);
  }

  // ── !shelp ─────────────────────────────────────────
  else if (command === "help") {
    message.reply(`🎵 Comandos de Spotify (MORFEO):
!splay <cancion/link spotify/playlist/album> - Reproducir
!spause - Pausar/reanudar
!sskip - Siguiente cancion
!sprev - Cancion anterior
!sstop - Desconectar bot
!sclean - Limpiar cola
!scolas - Ver cola actual
!sloop - Cambiar modo repeticion
!sshuffle - Mezclar cola
!svolume <1-200> - Ajustar volumen
!snp - Ver cancion actual
!shelp - Ver esta lista`);
  }
});

client.login(process.env.TOKEN);