const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { promisify } = require('util');
const execPromise = promisify(exec);

console.log('🎯 STRICT 5-SECOND CHUNKER - AUTO FRAMERATE DETECTION');

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('chunks')) fs.mkdirSync('chunks');

const app = express();
app.use(express.json({ limit: '500mb' }));

async function downloadFile(url, filepath) {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
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
    
    // Parse framerate (e.g., "30/1" or "30000/1001")
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
  try {
    const { video, chunkSize = 5 } = req.body;
    const timestamp = Date.now();
    let inputPath;
    let shouldCleanup = false;

    // Handle Input Source
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

    // AUTO-DETECT FRAMERATE
    const fps = await getFramerate(inputPath);
    const gopSize = Math.floor(chunkSize * fps);

    console.log(`🎬 Using GOP size: ${gopSize} frames (${fps} fps × ${chunkSize}s)`);

    // CORRECTED COMMAND with auto-detected framerate
    const outputPattern = `chunks/chunk_${timestamp}_%03d.mp4`;
    const cmd = `ffmpeg -i "${inputPath}" \
      -c:v libx264 \
      -preset fast \
      -g ${gopSize} \
      -keyint_min ${gopSize} \
      -force_key_frames "expr:gte(t,n_forced*${chunkSize})" \
      -sc_threshold 0 \
      -c:a aac \
      -b:a 128k \
      -ar 44100 \
      -f segment \
      -segment_time ${chunkSize} \
      -segment_start_number 0 \
      -break_non_keyframes 1 \
      -reset_timestamps 1 \
      -avoid_negative_ts make_zero \
      "${outputPattern}"`;

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
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, '0.0.0.0', () => {
  console.log('✅ FFmpeg API running on port 8080');
});