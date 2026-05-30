const http = require('http');
const https = require('https');
const fs = require('fs');
const url = require('url');
const { MongoClient, ObjectId } = require('mongodb');

const CONFIG = {
  TOKEN: process.env.TOKEN,
  USER_ID: process.env.USER_ID,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  MONGODB_URI: process.env.MONGODB_URI,
  PORT: process.env.PORT || 3000
};

// ============================================================
// MONGODB
// ============================================================
let db = null;

async function connectDB() {
  const client = new MongoClient(CONFIG.MONGODB_URI);
  await client.connect();
  db = client.db('loopreels');
  console.log('✅ MongoDB conectado!');

  // Garantir índices
  await db.collection('posts').createIndex({ scheduledTime: 1 });
  await db.collection('posts').createIndex({ status: 1 });
}

async function getPosts() {
  return await db.collection('posts').find({}).sort({ scheduledTime: 1 }).toArray();
}

async function createPost(post) {
  const result = await db.collection('posts').insertOne({
    ...post,
    createdAt: new Date().toISOString()
  });
  return { ...post, _id: result.insertedId };
}

async function updatePost(id, update) {
  await db.collection('posts').updateOne({ _id: new ObjectId(id) }, { $set: update });
}

async function deletePostById(id) {
  await db.collection('posts').deleteOne({ _id: new ObjectId(id) });
}

async function deletePostsByStatus(status) {
  if (status === 'todos') {
    await db.collection('posts').deleteMany({});
  } else {
    await db.collection('posts').deleteMany({ status });
  }
}

async function getLoop() {
  const loop = await db.collection('settings').findOne({ key: 'loop' });
  return loop?.value || { active: false, videos: [], currentIndex: 0, accountIds: [], timesPerDay: ['09:00','13:00','19:00'] };
}

async function saveLoop(loop) {
  await db.collection('settings').updateOne(
    { key: 'loop' },
    { $set: { key: 'loop', value: loop } },
    { upsert: true }
  );
}

async function getSettings() {
  const s = await db.collection('settings').findOne({ key: 'settings' });
  return s?.value || { delayBetweenAccounts: 5, timezone: 'America/Sao_Paulo' };
}

async function saveSettings(settings) {
  await db.collection('settings').updateOne(
    { key: 'settings' },
    { $set: { key: 'settings', value: settings } },
    { upsert: true }
  );
}

// ============================================================
// CLOUDINARY
// ============================================================
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

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${safeName}`);
    fs.writeFileSync(tmpPath, fileBuffer);
    console.log(`💾 Arquivo salvo: ${tmpPath}`);

    const publicId = `loopreels/${Date.now()}_${safeName.replace(/\.[^/.]+$/, '').slice(0, 50)}`;

    cloudinary.uploader.upload(tmpPath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: false
    }, (error, result) => {
      try { fs.unlinkSync(tmpPath); } catch(e) {}
      if (error) { console.log('❌ Erro Cloudinary:', error.message); reject(error); }
      else { console.log('✅ Upload OK:', result.secure_url.slice(0, 60)); resolve(result); }
    });
  });
}

// ============================================================
// MULTIPART PARSER
// ============================================================
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

// ============================================================
// METRICOOL API
// ============================================================
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

async function normalizeMedia(mediaUrl, blogId) {
  console.log(`🔄 Normalizando: ${mediaUrl.slice(0, 60)}...`);
  const res = await metricoolRequest('GET', `/actions/normalize/image/url?url=${encodeURIComponent(mediaUrl)}&userId=${CONFIG.USER_ID}&blogId=${blogId}`);
  if (typeof res.data === 'string' && res.data.startsWith('http')) return res.data;
  if (res.data && res.data.url) return res.data.url;
  throw new Error('Falha ao normalizar: ' + JSON.stringify(res.data));
}

async function schedulePost(blogId, mediaUrl, caption, scheduledTime, type = 'REEL', thumbnailUrl = null) {
  const normalizedMediaUrl = await normalizeMedia(mediaUrl, blogId);
  let normalizedThumbUrl = null;
  if (thumbnailUrl) {
    try { normalizedThumbUrl = await normalizeMedia(thumbnailUrl, blogId); }
    catch(e) { console.log('Aviso: falha ao normalizar thumbnail'); }
  }

  const body = {
    shortener: false, draft: false, text: caption, firstCommentText: '',
    autoPublish: true, saveExternalMediaFiles: false,
    media: [normalizedMediaUrl], mediaAltText: [null],
    providers: [{ network: 'instagram' }],
    publicationDate: { dateTime: scheduledTime, timezone: 'America/Sao_Paulo' },
    hasNotReadNotes: false, performanceDashboardIds: [], descendants: [],
    smartLinkData: { ids: [] },
    instagramData: { type, showReelOnFeed: true, collaborators: [], shareTrialAutomatically: false }
  };

  if (normalizedThumbUrl) body.videoThumbnailUrl = normalizedThumbUrl;

  console.log(`📤 Enviando para Metricool — conta ${blogId} — ${scheduledTime}`);
  const res = await metricoolRequest('POST', `/v2/scheduler/posts?userId=${CONFIG.USER_ID}&blogId=${blogId}`, body);
  console.log('Resposta:', JSON.stringify(res.data).slice(0, 200));
  return res;
}

// ============================================================
// AGENDADOR
// ============================================================
function startScheduler() {
  console.log('⏰ Agendador iniciado');
  setInterval(async () => {
    try {
      const posts = await getPosts();
      const now = new Date();
      const nowStr = now.toISOString().slice(0, 16);

      for (let post of posts) {
        if (post.status === 'agendado' && post.scheduledTime <= nowStr) {
          console.log(`\n🕐 Postando na conta ${post.blogId}...`);
          try {
            await schedulePost(post.blogId, post.mediaUrl, post.caption, post.scheduledTime, post.type, post.thumbnailUrl);
            await updatePost(post._id.toString(), { status: 'publicado', publishedAt: now.toISOString() });
            console.log(`✅ Publicado!`);
          } catch(e) {
            await updatePost(post._id.toString(), { status: 'erro', error: e.message });
            console.log(`❌ Erro:`, e.message);
          }
        }
      }

      // Loop automático
      const loop = await getLoop();
      if (loop.active && loop.videos.length > 0) {
        const currentHour = now.toTimeString().slice(0, 5);
        if (loop.timesPerDay.includes(currentHour) && now.getSeconds() < 60) {
          const video = loop.videos[loop.currentIndex % loop.videos.length];
          const settings = await getSettings();
          for (let i = 0; i < loop.accountIds.length; i++) {
            const blogId = loop.accountIds[i];
            setTimeout(async () => {
              try {
                await schedulePost(blogId, video.url, video.caption, nowStr, 'REEL', video.thumbnailUrl);
                console.log(`🔁 Loop: vídeo ${loop.currentIndex + 1} na conta ${blogId}`);
              } catch(e) { console.log(`❌ Loop erro:`, e.message); }
            }, i * (settings.delayBetweenAccounts * 60000));
          }
          loop.currentIndex = (loop.currentIndex + 1) % loop.videos.length;
          await saveLoop(loop);
        }
      }
    } catch(e) { console.error('Erro no agendador:', e.message); }
  }, 60000);
}

// ============================================================
// SERVIDOR HTTP
// ============================================================
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
      const result = await uploadToCloudinary(files.video.buffer, files.video.filename, 'video');
      const thumbnail = result.secure_url.replace('/upload/', '/upload/so_2,w_720,h_1280,c_fill/').replace(/\.(mp4|mov)$/i, '.jpg');
      return sendJSON(res, 200, { success: true, url: result.secure_url, thumbnail });
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
      const r = await metricoolRequest('GET', `/admin/profiles?userId=${CONFIG.USER_ID}&blogId=${CONFIG.USER_ID}`);
      return sendJSON(res, 200, { success: true, accounts: r.data });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Posts
  if (pathname === '/api/posts' && method === 'GET') {
    try {
      const posts = await getPosts();
      return sendJSON(res, 200, { success: true, posts });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  if (pathname === '/api/posts' && method === 'POST') {
    try {
      const body = await parseBody(req);
      const { mediaUrl, thumbnailUrl, caption, scheduledTime, blogIds, type } = body;
      const created = [];
      for (const blogId of blogIds) {
        const post = await createPost({ blogId, mediaUrl, thumbnailUrl: thumbnailUrl || null, caption, scheduledTime, type: type || 'REEL', status: 'agendado' });
        created.push(post);
      }
      return sendJSON(res, 201, { success: true, posts: created });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  if (pathname.startsWith('/api/posts/') && method === 'DELETE') {
    try {
      const id = pathname.split('/')[3];
      await deletePostById(id);
      return sendJSON(res, 200, { success: true });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Delete por status
  if (pathname === '/api/posts/bulk-delete' && method === 'POST') {
    try {
      const body = await parseBody(req);
      await deletePostsByStatus(body.status || 'todos');
      return sendJSON(res, 200, { success: true });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Loop
  if (pathname === '/api/loop' && method === 'GET') {
    try { return sendJSON(res, 200, { success: true, loop: await getLoop() }); }
    catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  if (pathname === '/api/loop' && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const loop = await getLoop();
      const updated = { ...loop, ...body };
      await saveLoop(updated);
      return sendJSON(res, 200, { success: true, loop: updated });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Stats
  if (pathname === '/api/stats' && method === 'GET') {
    try {
      const posts = await getPosts();
      const loop = await getLoop();
      return sendJSON(res, 200, { success: true, stats: {
        totalScheduled: posts.filter(p => p.status === 'agendado').length,
        totalPublished: posts.filter(p => p.status === 'publicado').length,
        totalError: posts.filter(p => p.status === 'erro').length,
        loopActive: loop.active,
        loopVideos: loop.videos.length,
        loopIndex: loop.currentIndex
      }});
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  // Settings
  if (pathname === '/api/settings' && method === 'GET') {
    try { return sendJSON(res, 200, { success: true, settings: await getSettings() }); }
    catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    try {
      const body = await parseBody(req);
      const settings = await getSettings();
      const updated = { ...settings, ...body };
      await saveSettings(updated);
      return sendJSON(res, 200, { success: true, settings: updated });
    } catch(e) { return sendJSON(res, 500, { success: false, error: e.message }); }
  }

  sendJSON(res, 404, { success: false, error: 'Rota não encontrada' });
});

// Iniciar
connectDB().then(() => {
  server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Loop Reels rodando na porta ${CONFIG.PORT}\n`);
    startScheduler();
  });
}).catch(e => {
  console.error('❌ Erro ao conectar MongoDB:', e.message);
  process.exit(1);
});
