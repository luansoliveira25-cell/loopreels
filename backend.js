const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');

const CONFIG = {
  TOKEN: process.env.TOKEN,
  USER_ID: process.env.USER_ID,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  PORT: process.env.PORT || 3000,
  DB_FILE: './loopreels-db.json'
};

function loadDB() {
  if (!fs.existsSync(CONFIG.DB_FILE)) {
    fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify({
      posts: [],
      loop: { active: false, videos: [], currentIndex: 0, accountIds: [], timesPerDay: ['09:00','13:00','19:00'] },
      settings: { delayBetweenAccounts: 5, timezone: 'America/Sao_Paulo' }
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG.DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(CONFIG.DB_FILE, JSON.stringify(data, null, 2));
}

// Upload para Cloudinary
function uploadToCloudinary(fileBuffer, fileName, resourceType = 'video') {
  return new Promise((resolve, reject) => {
    const cloudinary = require('cloudinary').v2;
    const os = require('os');
    const path = require('path');

    cloudinary.config({
      cloud_name: CONFIG.CLOUDINARY_CLOUD_NAME,
      api_key: CONFIG.CLOUDINARY_API_KEY,
      api_secret: CONFIG.CLOUDINARY_API_SECRET
    });

    // Salva no disco temporariamente
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${safeName}`);
    fs.writeFileSync(tmpPath, fileBuffer);
    console.log(`💾 Arquivo salvo temporariamente: ${tmpPath}`);

    const publicId = `loopreels/${Date.now()}_${safeName.replace(/\.[^/.]+$/, '').slice(0, 50)}`;

    cloudinary.uploader.upload(tmpPath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: false
    }, (error, result) => {
      // Remove arquivo temporário
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      if (error) {
        console.log('❌ Erro Cloudinary:', error.message);
        reject(error);
      } else {
        console.log('✅ Upload Cloudinary OK:', result.secure_url.slice(0, 60));
        resolve(result);
      }
    });
  });
}

// Parse multipart
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundary = (req.headers['content-type'] || '').split('boundary=')[1];
      if (!boundary) { resolve({ fields: {}, files: {} }); return; }
      const fields = {}, files = {};
      const parts = buffer.toString('binary').split(`--${boundary}`);
      for (const part of parts) {
        if (!part || part === '--\r\n') continue;
        const [headerSection, ...bodyParts] = part.split('\r\n\r\n');
        if (!headerSection) continue;
        const body = bodyParts.join('\r\n\r\n').replace(/\r\n$/, '');
        const nameMatch = headerSection.match(/name="([^"]+)"/);
        const filenameMatch = headerSection.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        if (filenameMatch) {
          files[nameMatch[1]] = { filename: filenameMatch[1], buffer: Buffer.from(body, 'binary'), contentType: (headerSection.match(/Content-Type: (.+)/) || [])[1]?.trim() };
        } else { fields[nameMatch[1]] = body; }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

// Chamada Metricool
function metricoolRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'app.metricool.com',
      path: `/api${endpoint}`,
      method,
      headers: {
        'X-Mc-Auth': CONFIG.TOKEN,
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Normalizar URL no Metricool (obrigatório antes de postar)
async function normalizeMedia(mediaUrl, blogId) {
  console.log(`🔄 Normalizando URL no Metricool: ${mediaUrl.slice(0, 60)}...`);
  const res = await metricoolRequest('GET', `/actions/normalize/image/url?url=${encodeURIComponent(mediaUrl)}&userId=${CONFIG.USER_ID}&blogId=${blogId}`);
  console.log('Resposta normalize:', JSON.stringify(res.data).slice(0, 200));
  // Resposta pode ser string direta ou objeto {url: ...}
  if (typeof res.data === 'string' && res.data.startsWith('http')) return res.data;
  if (res.data && res.data.url) return res.data.url;
  throw new Error('Falha ao normalizar mídia: ' + JSON.stringify(res.data));
}

// Agendar post no Metricool
async function schedulePost(blogId, mediaUrl, caption, scheduledTime, type = 'REEL', thumbnailUrl = null) {
  // PASSO 1: Normalizar a mídia no servidor do Metricool
  const normalizedMediaUrl = await normalizeMedia(mediaUrl, blogId);

  // PASSO 2: Normalizar thumbnail se existir
  let normalizedThumbUrl = null;
  if (thumbnailUrl) {
    try {
      normalizedThumbUrl = await normalizeMedia(thumbnailUrl, blogId);
    } catch(e) {
      console.log('Aviso: falha ao normalizar thumbnail, continuando sem ela');
    }
  }

  // PASSO 3: Criar post com URL normalizada
  const body = {
    shortener: false,
    draft: false,
    text: caption,
    firstCommentText: '',
    autoPublish: true,
    saveExternalMediaFiles: false,
    media: [normalizedMediaUrl],
    mediaAltText: [null],
    providers: [{ network: 'instagram' }],
    publicationDate: { dateTime: scheduledTime, timezone: 'America/Sao_Paulo' },
    hasNotReadNotes: false,
    performanceDashboardIds: [],
    descendants: [],
    smartLinkData: { ids: [] },
    instagramData: { type, showReelOnFeed: true, collaborators: [], shareTrialAutomatically: false }
  };

  if (normalizedThumbUrl) body.videoThumbnailUrl = normalizedThumbUrl;

  console.log(`📤 Enviando para Metricool — conta ${blogId} — horário ${scheduledTime}`);
  const res = await metricoolRequest('POST', `/v2/scheduler/posts?userId=${CONFIG.USER_ID}&blogId=${blogId}`, body);
  console.log('Resposta Metricool:', JSON.stringify(res.data).slice(0, 300));
  return res;
}

// Agendador automático
function startScheduler() {
  console.log('⏰ Agendador iniciado — verificando a cada minuto');
  setInterval(async () => {
    const db = loadDB();
    const now = new Date();
    const nowStr = now.toISOString().slice(0, 16);
    for (let post of db.posts) {
      if (post.status === 'agendado' && post.scheduledTime <= nowStr) {
        console.log(`\n🕐 Horário chegou! Postando na conta ${post.blogId}...`);
        try {
          await schedulePost(post.blogId, post.mediaUrl, post.caption, post.scheduledTime, post.type, post.thumbnailUrl);
          post.status = 'publicado';
          post.publishedAt = now.toISOString();
          console.log(`✅ Publicado com sucesso!`);
        } catch(e) {
          post.status = 'erro';
          post.error = e.message;
          console.log(`❌ Erro ao publicar:`, e.message);
        }
        saveDB(db);
      }
    }
    // Loop automático
    if (db.loop.active && db.loop.videos.length > 0) {
      const currentHour = now.toTimeString().slice(0, 5);
      if (db.loop.timesPerDay.includes(currentHour) && now.getSeconds() < 60) {
        const video = db.loop.videos[db.loop.currentIndex % db.loop.videos.length];
        for (let i = 0; i < db.loop.accountIds.length; i++) {
          const blogId = db.loop.accountIds[i];
          setTimeout(async () => {
            try {
              await schedulePost(blogId, video.url, video.caption, nowStr, 'REEL', video.thumbnailUrl);
              console.log(`🔁 Loop: vídeo ${db.loop.currentIndex + 1} postado na conta ${blogId}`);
            } catch(e) { console.log(`❌ Loop erro conta ${blogId}:`, e.message); }
          }, i * (db.settings.delayBetweenAccounts * 60000));
        }
        db.loop.currentIndex = (db.loop.currentIndex + 1) % db.loop.videos.length;
        saveDB(db);
      }
    }
  }, 60000);
}

// Helpers HTTP
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// Servidor
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  console.log(`${method} ${pathname}`);

  // Upload vídeo
  if (pathname === '/api/upload/video' && method === 'POST') {
    try {
      const { files } = await parseMultipart(req);
      if (!files.video) return sendJSON(res, 400, { success: false, error: 'Nenhum vídeo enviado' });
      console.log(`☁️ Enviando para Cloudinary: ${files.video.filename}`);
      const result = await uploadToCloudinary(files.video.buffer, files.video.filename, 'video');
      const thumbnail = result.secure_url.replace('/upload/', '/upload/so_2,w_720,h_1280,c_fill/').replace(/\.(mp4|mov)$/i, '.jpg');
      return sendJSON(res, 200, { success: true, url: result.secure_url, publicId: result.public_id, thumbnail });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Upload thumbnail
  if (pathname === '/api/upload/thumbnail' && method === 'POST') {
    try {
      const { files } = await parseMultipart(req);
      if (!files.thumbnail) return sendJSON(res, 400, { success: false, error: 'Nenhuma imagem enviada' });
      const result = await uploadToCloudinary(files.thumbnail.buffer, files.thumbnail.filename, 'image');
      return sendJSON(res, 200, { success: true, url: result.secure_url });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Contas
  if (pathname === '/api/accounts' && method === 'GET') {
    try {
      const r = await metricoolRequest('GET', `/admin/simpleProfiles?userId=${CONFIG.USER_ID}&blogId=${CONFIG.USER_ID}`);
      return sendJSON(res, 200, { success: true, accounts: r.data });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Posts
  if (pathname === '/api/posts' && method === 'GET') {
    return sendJSON(res, 200, { success: true, posts: loadDB().posts });
  }

  if (pathname === '/api/posts' && method === 'POST') {
    const body = await parseBody(req);
    const db = loadDB();
    const { mediaUrl, thumbnailUrl, caption, scheduledTime, blogIds, type } = body;
    const newPosts = blogIds.map(blogId => ({
      id: Date.now() + Math.random(), blogId, mediaUrl, thumbnailUrl: thumbnailUrl || null,
      caption, scheduledTime, type: type || 'REEL', status: 'agendado', createdAt: new Date().toISOString()
    }));
    db.posts.push(...newPosts);
    saveDB(db);
    return sendJSON(res, 201, { success: true, posts: newPosts });
  }

  if (pathname.startsWith('/api/posts/') && method === 'DELETE') {
    const id = parseFloat(pathname.split('/')[3]);
    const db = loadDB();
    db.posts = db.posts.filter(p => p.id !== id);
    saveDB(db);
    return sendJSON(res, 200, { success: true });
  }

  // Loop
  if (pathname === '/api/loop' && method === 'GET') {
    return sendJSON(res, 200, { success: true, loop: loadDB().loop });
  }

  if (pathname === '/api/loop' && method === 'PUT') {
    const body = await parseBody(req);
    const db = loadDB();
    db.loop = { ...db.loop, ...body };
    saveDB(db);
    return sendJSON(res, 200, { success: true, loop: db.loop });
  }

  // Stats
  if (pathname === '/api/stats' && method === 'GET') {
    const db = loadDB();
    const today = new Date().toISOString().slice(0, 10);
    return sendJSON(res, 200, { success: true, stats: {
      totalScheduled: db.posts.filter(p => p.status === 'agendado').length,
      totalPublished: db.posts.filter(p => p.status === 'publicado').length,
      totalError: db.posts.filter(p => p.status === 'erro').length,
      loopActive: db.loop.active,
      loopVideos: db.loop.videos.length,
      loopIndex: db.loop.currentIndex
    }});
  }

  // Settings
  if (pathname === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, { success: true, settings: loadDB().settings });
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await parseBody(req);
    const db = loadDB();
    db.settings = { ...db.settings, ...body };
    saveDB(db);
    return sendJSON(res, 200, { success: true, settings: db.settings });
  }

  sendJSON(res, 404, { success: false, error: 'Rota não encontrada' });
});

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Loop Reels rodando na porta ${CONFIG.PORT}\n`);
  startScheduler();
});
