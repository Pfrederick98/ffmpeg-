const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { promisify } = require('util');
const multer = require('multer');
const execPromise = promisify(exec);

console.log('🎯 STRICT 5-SECOND CHUNKER - AUTO FRAMERATE DETECTION');

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('chunks')) fs.mkdirSync('chunks');

const app = express();
app.use(express.json({ limit: '500mb' }));
const upload = multer({ dest: 'uploads/' });

async function downloadFile(url, filepath) {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({ 
    url, 
    method: 'GET', 
    responseType: 'stream',
    timeout: 60000
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function getFramerate(inputPath) {
  try {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`;
    const { stdout } = await execPromise(cmd);
    
    const [num, den] = stdout.trim().split('/').map(Number);
    const fps = num / den;
    
    console.log(`📊 Detected framerate: ${fps.toFixed(2)} fps (${stdout.trim()})`);
    return Math.round(fps);
  } catch (error) {
    console.warn('⚠️ Could not detect framerate, defaulting to 30fps');
    return 30;
  }
}

app.post('/chunk', async (req, res) => {
  console.log('=== REQUEST DEBUG ===');
  console.log('Body:', JSON.stringify(req.body));
  console.log('Headers:', req.headers);
  console.log('===================');
  
  try {
    const { video, chunkSize = 5 } = req.body;
    const timestamp = Date.now();
    let inputPath;
    let shouldCleanup = false;

    if (video.startsWith('http')) {
      inputPath = `uploads/input_${timestamp}.mp4`;
      await downloadFile(video, inputPath);
      shouldCleanup = true;
    } else if (video.startsWith('data:') || video.length > 500) {
      inputPath = `uploads/input_${timestamp}.mp4`;
      const base64Data = video.replace(/^data:video\/\w+;base64,/, '');
      fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
      shouldCleanup = true;
    } else {
      inputPath = video;
      if (!fs.existsSync(inputPath)) return res.status(400).json({ error: 'File not found' });
    }

    const fps = await getFramerate(inputPath);
    const gopSize = Math.floor(chunkSize * fps);

    console.log(`🎬 Using GOP size: ${gopSize} frames (${fps} fps × ${chunkSize}s)`);

    const outputPattern = `chunks/chunk_${timestamp}_%03d.mp4`;
    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -g ${gopSize} -keyint_min ${gopSize} -force_key_frames "expr:gte(t,n_forced*${chunkSize})" -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -f segment -segment_time ${chunkSize} -segment_start_number 0 -break_non_keyframes 1 -reset_timestamps 1 -avoid_negative_ts make_zero "${outputPattern}"`;

    console.log('Running command:', cmd);

    exec(cmd, (error, stdout, stderr) => {
      if (shouldCleanup && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      
      if (error) {
        console.error('FFmpeg Error:', stderr);
        return res.status(500).json({ error: 'FFmpeg failed to process video', details: stderr });
      }
      
      const allFiles = fs.readdirSync('chunks');
      const currentChunks = allFiles
        .filter(f => f.startsWith(`chunk_${timestamp}`))
        .sort()
        .map(f => path.join('chunks', f));
      
      console.log(`✅ Created ${currentChunks.length} chunks at ${fps}fps`);
      
      res.json({ 
        success: true, 
        count: currentChunks.length,
        chunks: currentChunks,
        fps: fps,
        gopSize: gopSize
      });
    });
  } catch (err) {
    console.error('ERROR:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/chunk-upload', upload.single('video'), async (req, res) => {
  try {
    const inputPath = req.file.path;
    const chunkSize = parseInt(req.body.chunkSize) || 5;
    const timestamp = Date.now();
    
    const fps = await getFramerate(inputPath);
    const gopSize = Math.floor(chunkSize * fps);
    
    const outputPattern = `chunks/chunk_${timestamp}_%03d.mp4`;
    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -g ${gopSize} -keyint_min ${gopSize} -force_key_frames "expr:gte(t,n_forced*${chunkSize})" -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -f segment -segment_time ${chunkSize} -segment_start_number 0 -break_non_keyframes 1 -reset_timestamps 1 -avoid_negative_ts make_zero "${outputPattern}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      fs.unlinkSync(inputPath);
      
      if (error) return res.status(500).json({ error: 'Processing failed', details: stderr });
      
      const chunks = fs.readdirSync('chunks')
        .filter(f => f.startsWith(`chunk_${timestamp}`))
        .sort()
        .map(f => path.join('chunks', f));
      
      res.json({ success: true, count: chunks.length, chunks, fps, gopSize });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FFmpeg API running on port ${PORT}`);
});