const http = require('http');
const https = require('https');
const querystring = require('querystring');
const url = require('url');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const server = http.createServer(async (req, res) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/auth/callback') {
    const code = parsedUrl.query.code;

    if (!code) {
      res.writeHead(400);
      res.end('Codigo nao encontrado.');
      return;
    }

    console.log('\n Codigo recebido:', code);
    console.log('Trocando pelo token...\n');

    const postData = querystring.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code: code
    });

    const options = {
      hostname: 'api.instagram.com',
      path: '/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('end', () => {
        const json = JSON.parse(data);
        if (json.access_token) {
          console.log('\nTOKEN GERADO COM SUCESSO!\n');
          console.log('Access Token:', json.access_token);
          console.log('User ID:', json.user_id);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Token gerado!</h2><textarea rows="5" style="width:100%">' + json.access_token + '</textarea><p>User ID: ' + json.user_id + '</p>');
        } else {
          console.log('Erro:', JSON.stringify(json, null, 2));
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h2>Erro</h2><pre>' + JSON.stringify(json, null, 2) + '</pre>');
        }
        
      });
    });

    apiReq.on('error', (e) => {
      console.error('Erro de conexao:', e.message);
      res.end('Erro de conexao.');
    });

    apiReq.write(postData);
    apiReq.end();
  } else {
    res.writeHead(404);
    res.end('Pagina nao encontrada.');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log('\nCole essa URL no navegador:');
  console.log('https://www.instagram.com/oauth/authorize?force_reauth=true&client_id=' + CLIENT_ID + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI) + '&response_type=code&scope=instagram_business_basic%2Cinstagram_business_content_publish\n');
});