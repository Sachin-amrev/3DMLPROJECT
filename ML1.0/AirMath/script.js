const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const statusPill = document.getElementById('status_pill');
const equationDisplay = document.getElementById('equation_display');
const solutionDisplay = document.getElementById('solution_display');
const graphContainer = document.getElementById('graph_container');

// State
let isDrawing = false;
let lastPoint = null;
let strokePath = [];
let silenceTimer = null;
const SILENCE_DELAY = 2000; // 2 seconds of no movement/drawing triggers processing

// Tesseract Setup
let tesseractWorker = null;

async function initTesseract() {
    statusPill.textContent = 'Loading OCR...';
    try {
        tesseractWorker = await Tesseract.createWorker("eng", 1, {
            logger: m => console.log(m),
            errorHandler: err => console.error(err)
        });

        // Optimize for math-like characters if possible
        await tesseractWorker.setParameters({
            tessedit_char_whitelist: '0123456789xyzXYZ+-=().,^*/ '
        });

        statusPill.textContent = 'Ready';
        statusPill.style.borderColor = 'var(--success)';
    } catch (e) {
        console.error('Tesseract failed', e);
        statusPill.textContent = 'OCR Failed';
        statusPill.style.borderColor = 'red';
    }
}

// MediaPipe Setup
const hands = new Hands({
    locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }
});

hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
});

hands.onResults(onResults);

// Camera Setup
const camera = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
    width: 640,
    height: 480
});

// Start
initTesseract().then(() => {
    camera.start();
});

// Drawing Logic
function onResults(results) {
    // 1. Clear Canvas for new frame (but we need to persist the stroke?)
    // Actually, we want to overlay the video feed + the persistent stroke.
    // To do this, we clear, draw video, then draw stroke.


    // Clear
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Draw Video Feed or Black Background
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1); // Mirror

    if (showCamera) {
        canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
    } else {
        canvasCtx.fillStyle = '#0f172a'; // Match bg-dark
        canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);
    }

    canvasCtx.restore();


    // Draw Skeleton (Optional, for feedback)
    if (results.multiHandLandmarks) {
        for (const landmarks of results.multiHandLandmarks) {
            // Mirror landmarks for drawing utils? No, we already mirrored canvas ctx? 
            // Wait, we restored ctx. So we need to mirror again or draw manually.
            // Let's just draw the index tip manually for cursor.

            drawCursorAndTrack(landmarks);
        }
    }

    // Draw the Persistent Stroke (on top of video)
    drawStroke();
}

function drawCursorAndTrack(landmarks) {
    const indexTip = landmarks[8];
    const indexPip = landmarks[6]; // PIP joint

    // Check if Index finger is extended (Tip y < Pip y - threshold? in screen coords y is down)
    // Actually, just check if Index Tip is above other fingers or simpler:
    // "Stop drawing when hand is closed".
    // Closed hand: Keypoints distance or just check Tip vs Base.
    // Let's use a "Drawing Mode" state based on Index Finger Extension.
    // If Index Tip is simply trusted as the pen. We toggle "ink" based on gesture.
    // Gesture: Index Finger Extended, others curled?
    // Let's simplified: If Index Tip is detected, we draw.
    // To Stop: We need a "Hand Closed" gesture.
    // Hand Closed = Index Tip (8) close to Wrist (0) or Index MCP (5).

    // Calculate distance between Index Tip(8) and Wrist(0)
    // This varies by Z.
    // Simpler: Check "Pinch" (Index 8 + Thumb 4).
    // If Pinching -> Stop/Erase? 
    // User Requirement: "Stop drawing when the hand is closed".
    // Hand Close: Index Tip (8) is below Index PIP (6)? (Curled).

    const isIndexExtended = indexTip.y < indexPip.y; // Y is down, so Tip < Pip means Tip is higher (Up)

    // Map coordinates to canvas
    // Use raw x because canvasCtx is already mirrored with scale(-1, 1)
    const x = indexTip.x * canvasElement.width;
    const y = indexTip.y * canvasElement.height;

    // Visual Cursor
    canvasCtx.beginPath();
    canvasCtx.arc(x, y, 10, 0, 2 * Math.PI);
    canvasCtx.fillStyle = isIndexExtended ? '#10b981' : '#ef4444'; // Green if drawing, Red if stopped
    canvasCtx.fill();

    // Logic
    if (isIndexExtended) {
        // Drawing
        if (!isDrawing) {
            isDrawing = true;
            // New stroke segment?
            // For now, simpler: just one continuous line logic with gaps?
            // User requirement: "Continuous stroke input".
        }

        // Add point
        strokePath.push({ x, y });

        // Reset Silence Timer
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(processDrawing, SILENCE_DELAY);

        statusPill.textContent = 'Drawing...';
    } else {
        // Not Drawing
        if (isDrawing) {
            isDrawing = false;
            // Add a "break" in stroke?
            strokePath.push(null);
        }

        if (strokePath.length > 0 && !silenceTimer) {
            statusPill.textContent = 'Waiting...';
            silenceTimer = setTimeout(processDrawing, SILENCE_DELAY);
        }
    }
}

function drawStroke() {
    if (strokePath.length < 2) return;

    canvasCtx.lineWidth = 4;
    canvasCtx.strokeStyle = 'white';
    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';
    canvasCtx.beginPath();

    let hasStarted = false;

    for (let i = 0; i < strokePath.length; i++) {
        const point = strokePath[i];
        if (!point) {
            hasStarted = false;
            continue;
        }

        if (!hasStarted) {
            canvasCtx.moveTo(point.x, point.y);
            hasStarted = true;
        } else {
            // Smooth curve
            // For now simple line to line
            canvasCtx.lineTo(point.x, point.y);
        }
    }
    canvasCtx.stroke();
}

// Processing
async function processDrawing() {
    if (strokePath.length === 0) return;

    statusPill.textContent = 'Interpreting...';

    // 1. Create a clean image for OCR (White background, Black text or vice versa)
    // Tesseract prefers Black text on White? Or White on Black? Usually Black on White is standard.
    // We'll create a temporary canvas.
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasElement.width;
    tempCanvas.height = canvasElement.height;
    const tempCtx = tempCanvas.getContext('2d');

    // Fill White
    tempCtx.fillStyle = 'white';
    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Draw Stroke (Black)
    tempCtx.lineWidth = 5;
    tempCtx.strokeStyle = 'black';
    tempCtx.lineCap = 'round';
    tempCtx.lineJoin = 'round';

    // Mirror the temp context so the "Reverse" stroke becomes readable
    tempCtx.save();
    tempCtx.translate(tempCanvas.width, 0);
    tempCtx.scale(-1, 1);

    // Replay stroke
    tempCtx.beginPath();
    let hasStarted = false;
    for (let point of strokePath) {
        if (!point) { hasStarted = false; continue; }
        if (!hasStarted) { tempCtx.moveTo(point.x, point.y); hasStarted = true; }
        else { tempCtx.lineTo(point.x, point.y); }
    }
    tempCtx.stroke();
    tempCtx.restore();


    // 2. Send to Tesseract
    const dataUrl = tempCanvas.toDataURL('image/png');

    try {
        const result = await tesseractWorker.recognize(dataUrl);
        const text = result.data.text.trim().replace(/\s/g, ''); // Remove spaces
        console.log("Recognized:", text);

        displayEquation(text);
        solveMath(text);

        statusPill.textContent = 'Solved';

    } catch (err) {
        console.error(err);
        statusPill.textContent = 'Error';
    }

    // Clear logic? No, let user clear manually or auto-clear after success?
    // Requirement says "Display final answer".
    // We'll keep the stroke for now?
}

function displayEquation(text) {
    // Clean up comon OCR artifacts
    // e.g. "x2" -> "x^2", "l0" -> "10"
    // This is hard to perfect.
    equationDisplay.textContent = text || "?";
}

function solveMath(expression) {
    if (!expression) return;

    // Heuristic fixes for bad OCR
    // OCR often misses exponents. "x2" -> "x^2"
    // "2x" is fine.
    // "sin x" -> "sin(x)"
    expression = expression.toLowerCase();

    // Try to solve
    try {
        let solution = "";
        let graphFn = null;
        let type = 'simplification';

        if (expression.includes('=')) {
            // Equation? e.g. 2x + 4 = 9
            // MathJS doesn't solve equations directly easily without 'algebra' step.
            // Using a simple numeric solver or algebra.js if available.
            // For now, let's treat it as an eval.
            // Wait, Nerdsamer or similar is better for equations. 
            // MathJS is better for expressions.
            // Let's assume expression simplification.
            solution = "Equation solving limited in this demo";
        } else {
            // Simplify / Evaluate
            const node = math.parse(expression);
            const compiled = node.compile();

            // Check if variable x exists
            // If x, we plot.
            try {
                // Try to evaluate (e.g. "2+2")
                solution = compiled.evaluate();
                type = 'numeric';
            } catch (e) {
                // Has variables?
                solution = math.simplify(node).toString();
                type = 'symbolic';
            }

            // Differentiating? User asked for derivative?
            // Tesseract won't pick up "d/dx" easily.
            // If we detect "integral" char?
            // "∫" is hard for OCR.
            // If text contains "int" or similar?
            if (expression.includes('int')) {
                // handle integral
            }
        }

        solutionDisplay.innerHTML = `<div class="step">Result: ${solution}</div>`;

        // Graphing
        // We plot if it's a function of x
        // Let's plain try to plot "y = expression"
        tryPlot(expression);

    } catch (e) {
        solutionDisplay.innerHTML = `<div class="step error">Could not solve: ${e.message}</div>`;
    }
}

function tryPlot(expression) {
    // Simple plotter
    // Generate X values
    const xValues = [];
    const yValues = [];
    for (let x = -10; x <= 10; x += 0.5) {
        try {
            const scope = { x: x };
            const y = math.evaluate(expression, scope);
            xValues.push(x);
            yValues.push(y);
        } catch (e) { }
    }

    if (xValues.length > 2) {
        const trace = {
            x: xValues,
            y: yValues,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#6366f1' }
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { t: 20, r: 20, b: 40, l: 40 },
            font: { color: '#94a3b8' },
            xaxis: { gridcolor: '#334155' },
            yaxis: { gridcolor: '#334155' }
        };

        Plotly.newPlot(graphContainer, [trace], layout, { responsive: true, displayModeBar: false });
    }
}


// Setup Resize
function resize() {
    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;
}
videoElement.addEventListener('loadeddata', resize);
window.addEventListener('resize', resize);

// UI Controls
document.getElementById('clear_btn').addEventListener('click', () => {
    strokePath = [];
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    equationDisplay.textContent = '...';
    solutionDisplay.innerHTML = '';
    Plotly.purge(graphContainer);
});


let showCamera = true;

document.getElementById('toggle_cam_btn').addEventListener('click', () => {
    showCamera = !showCamera;
    const btn = document.getElementById('toggle_cam_btn');
    if (showCamera) {
        btn.innerHTML = '<span class="icon">📷</span> Hide Camera';
        btn.classList.add('active');
    } else {
        btn.innerHTML = '<span class="icon">📷</span> Show Camera';
        btn.classList.remove('active');
    }
});

// Update the draw loop to respect this flag
// In onResults:
// if (showCamera) { canvasCtx.drawImage(...) } else { canvasCtx.fillStyle = 'black'; canvasCtx.fillRect... }
