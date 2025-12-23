const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { promisify } = require('util');
const execPromise = promisify(exec);

console.log('🎯 COMPLETE CHUNKER & STITCHER API');

if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('chunks')) fs.mkdirSync('chunks');
if (!fs.existsSync('output')) fs.mkdirSync('output');

const app = express();
app.use(express.json({ limit: '500mb' }));
app.use(express.json({ type: 'text/plain', limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Serve static files
app.use('/chunks', express.static('chunks'));
app.use('/output', express.static('output'));

async function downloadFile(url, filepath) {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 60000 });
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

// GET VIDEO DURATION (NEW ENDPOINT)
app.post('/get-duration', async (req, res) => {
  try {
    const { video, chunkSize = 5 } = req.body;
    
    if (!video) {
      return res.status(400).json({ error: 'video parameter required (URL or path)' });
    }

    const timestamp = Date.now();
    let inputPath;
    let shouldCleanup = false;

    // Handle URL
    if (video.startsWith('http')) {
      console.log('📥 Downloading video for duration check...');
      inputPath = `uploads/duration_check_${timestamp}.mp4`;
      await downloadFile(video, inputPath);
      shouldCleanup = true;
    } 
    // Handle file path
    else {
      inputPath = video;
      if (!fs.existsSync(inputPath)) {
        return res.status(400).json({ error: 'File not found' });
      }
    }

    // Get duration using ffprobe
    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`;
    const { stdout } = await execPromise(durationCmd);
    const duration = parseFloat(stdout.trim());
    
    // Get framerate
    const fps = await getFramerate(inputPath);
    
    // Calculate expected chunks
    const expectedChunks = Math.ceil(duration / chunkSize);
    
    // Cleanup if downloaded
    if (shouldCleanup && fs.existsSync(inputPath)) {
      fs.unlinkSync(inputPath);
    }
    
    console.log(`📊 Duration: ${duration.toFixed(2)}s, Expected chunks: ${expectedChunks}`);
    
    res.json({
      success: true,
      duration: duration,
      fps: fps,
      chunkSize: chunkSize,
      expectedChunks: expectedChunks
    });
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// CHUNK ENDPOINT
app.post('/chunk', async (req, res) => {
  try {
    const { video, chunkSize = 5 } = req.body;
    
    if (!video) {
      return res.status(400).json({ error: 'video parameter required (URL or base64)' });
    }

    const timestamp = Date.now();
    let inputPath;
    let shouldCleanup = false;

    // Handle URL
    if (video.startsWith('http')) {
      console.log('📥 Downloading from URL...');
      inputPath = `uploads/input_${timestamp}.mp4`;
      await downloadFile(video, inputPath);
      shouldCleanup = true;
    } 
    // Handle Base64
    else if (video.startsWith('data:') || video.length > 500) {
      console.log('📥 Processing base64 data...');
      inputPath = `uploads/input_${timestamp}.mp4`;
      const base64Data = video.replace(/^data:video\/\w+;base64,/, '');
      fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
      shouldCleanup = true;
    } 
    // Handle file path
    else {
      inputPath = video;
      if (!fs.existsSync(inputPath)) {
        return res.status(400).json({ error: 'File not found' });
      }
    }

    const fps = await getFramerate(inputPath);
    const gopSize = Math.floor(chunkSize * fps);
    console.log(`🎬 GOP: ${gopSize} frames (${fps}fps × ${chunkSize}s)`);

    const outputPattern = `chunks/chunk_${timestamp}_%03d.mp4`;
    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -g ${gopSize} -keyint_min ${gopSize} -force_key_frames "expr:gte(t,n_forced*${chunkSize})" -sc_threshold 0 -c:a aac -b:a 128k -ar 44100 -f segment -segment_time ${chunkSize} -segment_start_number 0 -break_non_keyframes 1 -reset_timestamps 1 -avoid_negative_ts make_zero "${outputPattern}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (shouldCleanup && fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      
      if (error) {
        console.error('❌ FFmpeg Error:', stderr);
        return res.status(500).json({ error: 'Chunking failed', details: stderr });
      }
      
      const chunks = fs.readdirSync('chunks')
        .filter(f => f.startsWith(`chunk_${timestamp}`))
        .sort()
        .map(f => `chunks/${f}`);
      
      console.log(`✅ Created ${chunks.length} chunks`);
      
      res.json({ 
        success: true, 
        count: chunks.length,
        chunks: chunks,
        chunkUrls: chunks.map(c => `${req.protocol}://${req.get('host')}/${c}`),
        fps: fps,
        gopSize: gopSize,
        timestamp: timestamp
      });
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// STITCH ENDPOINT (with URL support)
app.post('/stitch', async (req, res) => {
  try {
    const { chunks } = req.body;
    
    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: 'chunks array required' });
    }

    const timestamp = Date.now();
    const downloadedChunks = [];
    
    // Download all URL chunks to temp files
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      if (chunk.startsWith('http')) {
        console.log(`📥 Downloading chunk ${i + 1}/${chunks.length}...`);
        const tempPath = `uploads/temp_chunk_${timestamp}_${i}.mp4`;
        await downloadFile(chunk, tempPath);
        downloadedChunks.push(tempPath);
      } else if (fs.existsSync(chunk)) {
        downloadedChunks.push(chunk);
      } else {
        return res.status(400).json({ error: `Chunk not found: ${chunk}` });
      }
    }

    const listFile = `uploads/filelist_${timestamp}.txt`;
    const outputFile = `output/stitched_${timestamp}.mp4`;

    const fileList = downloadedChunks.map(c => `file '../${c}'`).join('\n');
    fs.writeFileSync(listFile, fileList);

    console.log(`🔗 Stitching ${chunks.length} chunks...`);

    const cmd = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      // Cleanup
      fs.unlinkSync(listFile);
      downloadedChunks.forEach(c => {
        if (c.startsWith('uploads/temp_chunk_')) fs.unlinkSync(c);
      });
      
      if (error) {
        console.error('❌ Stitch Error:', stderr);
        return res.status(500).json({ error: 'Stitching failed', details: stderr });
      }
      
      console.log('✅ Stitched:', outputFile);
      
      res.json({ 
        success: true, 
        output: outputFile,
        downloadUrl: `${req.protocol}://${req.get('host')}/${outputFile}`,
        timestamp: timestamp
      });
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// STITCH TO BASE64 (with URL support)
app.post('/stitch-base64', async (req, res) => {
  try {
    const { chunks } = req.body;
    
    if (!chunks || !Array.isArray(chunks)) {
      return res.status(400).json({ error: 'chunks array required' });
    }

    const timestamp = Date.now();
    const downloadedChunks = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      if (chunk.startsWith('http')) {
        console.log(`📥 Downloading chunk ${i + 1}/${chunks.length}...`);
        const tempPath = `uploads/temp_chunk_${timestamp}_${i}.mp4`;
        await downloadFile(chunk, tempPath);
        downloadedChunks.push(tempPath);
      } else if (fs.existsSync(chunk)) {
        downloadedChunks.push(chunk);
      } else {
        return res.status(400).json({ error: `Chunk not found: ${chunk}` });
      }
    }

    const listFile = `uploads/filelist_${timestamp}.txt`;
    const outputFile = `output/stitched_${timestamp}.mp4`;

    const fileList = downloadedChunks.map(c => `file '../${c}'`).join('\n');
    fs.writeFileSync(listFile, fileList);

    console.log(`🔗 Stitching to base64...`);

    const cmd = `ffmpeg -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      // Cleanup temp files
      fs.unlinkSync(listFile);
      downloadedChunks.forEach(c => {
        if (c.startsWith('uploads/temp_chunk_')) fs.unlinkSync(c);
      });
      
      if (error) {
        console.error('❌ Stitch Error:', stderr);
        return res.status(500).json({ error: 'Stitching failed', details: stderr });
      }
      
      const videoBuffer = fs.readFileSync(outputFile);
      const base64Video = videoBuffer.toString('base64');
      
      fs.unlinkSync(outputFile);
      
      console.log('✅ Stitched to base64');
      
      res.json({ 
        success: true,
        base64: `data:video/mp4;base64,${base64Video}`,
        size: videoBuffer.length
      });
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// HEALTH CHECK
app.get('/', (req, res) => {
  res.json({ 
    status: 'online',
    endpoints: {
      getDuration: 'POST /get-duration - Get video duration and expected chunks',
      chunk: 'POST /chunk - Split video into chunks',
      stitch: 'POST /stitch - Combine chunks back together',
      stitchBase64: 'POST /stitch-base64 - Stitch and return as base64'
    }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ FFmpeg API running on port ${PORT}`);
  console.log(`📍 Endpoints:`);
  console.log(`   POST /get-duration - Get video info`);
  console.log(`   POST /chunk - Chunk videos`);
  console.log(`   POST /stitch - Stitch chunks (returns URL)`);
  console.log(`   POST /stitch-base64 - Stitch chunks (returns base64)`);
});