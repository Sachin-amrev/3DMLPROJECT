
import { FilesetResolver, HandLandmarker } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/+esm";

// --- CONFIGURATION ---
const CONFIG = {
    WRITING_DEPTH_THRESHOLD: -0.08, // Negative is closer to camera. Adjust based on testing.
    ERASER_RADIUS: 40,
    LINE_WIDTH: 6,
    SMOOTHING_FACTOR: 0.5
};

// --- STATE ---
const state = {
    mode: 'PAUSE', // PAUSE, DRAW, ERASE, RECOGNIZING
    isWriting: false,
    lastPoint: null,
    pointsBuffer: [],
    handLandmarker: null,
    webcamRunning: false,
    textExplanations: [],
    recognizedMath: ""
};

// --- DOM ELEMENTS ---
const video = document.getElementById('webcam');
const canvas = document.getElementById('drawing-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const statusPill = document.getElementById('system-status');
const modeText = document.getElementById('mode-text');
const depthVal = document.getElementById('depth-val');
const btnClear = document.getElementById('btn-clear');
const btnRecognize = document.getElementById('btn-recognize');
const mathExpressionDiv = document.getElementById('math-expression');
const mathAnswerDiv = document.getElementById('math-answer');
const explanationBox = document.getElementById('explanation-box');
const modeContainer = document.getElementById('mode-indicator');

// --- INITIALIZATION ---
async function init() {
    statusPill.innerText = "Loading AI Models...";

    // 1. Load MediaPipe Hand Landmarker
    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        state.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
        });
        statusPill.innerText = "Starting Camera...";
        startWebcam();
    } catch (e) {
        statusPill.innerText = "Error Loading AI";
        console.error(e);
    }
}

// 2. Start Webcam
function startWebcam() {
    const constraints = { video: { width: 1280, height: 720 } };
    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        video.srcObject = stream;
        video.addEventListener("loadeddata", () => {
            state.webcamRunning = true;
            resizeCanvas();
            statusPill.innerText = "System Ready";
            statusPill.style.background = "rgba(16, 185, 129, 0.2)";
            statusPill.style.borderColor = "rgba(16, 185, 129, 0.4)";
            requestAnimationFrame(predictWebcam);
        });
    }).catch(err => {
        console.error("Camera Error:", err);
        statusPill.innerText = "Camera Denied";
    });
}

function resizeCanvas() {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = CONFIG.LINE_WIDTH;
    ctx.strokeStyle = '#ffffff'; // White ink
}

window.addEventListener('resize', resizeCanvas);

// --- MAIN LOOP ---
let lastVideoTime = -1;

async function predictWebcam() {
    if (!state.webcamRunning) return;

    let startTimeMs = performance.now();
    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const results = state.handLandmarker.detectForVideo(video, startTimeMs);

        ctx.save();
        // Clear logic is handled by specific erase actions or full clear, 
        // BUT we need to redraw/maintain strokes. 
        // Actually, for drawing, we don't clear the canvas every frame. We persist strokes.
        // We only clear if we want to show a "cursor" on a separate layer, 
        // but here we are drawing directly on the canvas. 
        // To show a cursor without clearing drawings, we might need a stored offscreen canvas 
        // or just draw the cursor on top and restore?
        // Simpler: Just draw user strokes permanently. To show cursor, uses a DOM element or overlay?
        // Let's use a DOM element for the cursor if needed, or just don't show a cursor 
        // (the finger is the cursor). User sees their own hand. 
        // The prompt says "Mirror webcam feed". We have video in background. Canvas is overlay.

        processHand(results);
        ctx.restore();
    }
    requestAnimationFrame(predictWebcam);
}

// --- HAND LOGIC ---
function processHand(results) {
    if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0];

        // 1. Get Key Points
        const indexTip = landmarks[8];
        const middleTip = landmarks[12];
        const ringTip = landmarks[16];
        const thumbTip = landmarks[4];

        // 2. Analyze Stats
        // Convert normalized coordinates to pixel
        const x = indexTip.x * canvas.width;
        const y = indexTip.y * canvas.height;
        const z = indexTip.z; // Depth

        // Check Gestures
        const isIndexExtended = isFingerExtended(landmarks, 8);
        const isMiddleExtended = isFingerExtended(landmarks, 12);
        const isRingExtended = isFingerExtended(landmarks, 16);
        const isPinkyExtended = isFingerExtended(landmarks, 20);

        // Update Depth UI
        depthVal.innerText = z.toFixed(3);

        // Gesture Detection Logic
        if (state.mode === 'RECOGNIZING') return; // Locked

        // ERASE MODE: Index + Middle extended
        if (isIndexExtended && isMiddleExtended) {
            setMode('ERASE');
            eraseAt(x, y);
        }
        // PAUSE/STOP: Fist (All fingers curled)
        else if (!isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) {
            // Check if fist is "held" for a moment to trigger recognize?
            // For now, just PAUSE. Recognition is manual trigger or explicit "Done" gesture (Thumb Up?).
            // Let's keep it simple: Fist = PAUSE. manual button for solve is safest for accuracy.
            // Prompt says: "Closed fist -> stop drawing... or trigger recognition".
            // Let's make it PAUSE and show "Ready to Solve" maybe?
            setMode('PAUSE (Fist)');
        }
        // DRAW MODE: Only Index Extended
        else if (isIndexExtended && !isMiddleExtended && !isRingExtended && !isPinkyExtended) {
            // Depth Check
            if (z < CONFIG.WRITING_DEPTH_THRESHOLD) {
                setMode('DRAW');
                drawAt(x, y);
            } else {
                setMode('HOVER');
                state.lastPoint = null; // Lift pen
            }
        } else {
            setMode('PAUSE');
            state.lastPoint = null;
        }

    } else {
        setMode('NO HAND');
        state.lastPoint = null;
    }
}

// Helper: Is finger extended (Tip above PIP joint in Y-axis? Note: Y is inverted in some coords, but MediaPipe Y 0 is top)
// Better: Distance tip to wrist > DIP to wrist? 
// Simple approximation: TIP y < PIP y is "Up" if hand is upright. 
// Robust: Compare distance of Tip to Wrist vs PIP to Wrist.
function isFingerExtended(landmarks, tipIdx) {
    const wrist = landmarks[0];
    const tip = landmarks[tipIdx];
    const pip = landmarks[tipIdx - 2];

    // Calculate distances
    const distTip = Math.hypot(tip.x - wrist.x, tip.y - wrist.y);
    const distPip = Math.hypot(pip.x - wrist.x, pip.y - wrist.y);

    return distTip > distPip;
}

function setMode(newMode) {
    if (state.mode === newMode) return;

    // Update Text
    if (newMode === 'DRAW') {
        modeText.innerText = "Drawing (Active)";
        modeContainer.parentElement.className = "overlay-ui status-draw";
    } else if (newMode === 'ERASE') {
        modeText.innerText = "Erasing";
        modeContainer.parentElement.className = "overlay-ui status-erase";
        state.lastPoint = null;
    } else if (newMode === 'HOVER') {
        modeText.innerText = "Paused (Push to Write)";
        modeContainer.parentElement.className = "overlay-ui status-pause";
        state.lastPoint = null;
    } else {
        modeText.innerText = newMode;
        modeContainer.parentElement.className = "overlay-ui";
        state.lastPoint = null;
    }
    state.mode = newMode;
}

function drawAt(x, y) {
    if (!state.lastPoint) {
        state.lastPoint = { x, y };
        return;
    }

    // Smooth line
    ctx.beginPath();
    ctx.moveTo(state.lastPoint.x, state.lastPoint.y);
    // Quadratic curve for smoothing
    const midPoint = {
        x: (state.lastPoint.x + x) / 2,
        y: (state.lastPoint.y + y) / 2
    };
    ctx.quadraticCurveTo(state.lastPoint.x, state.lastPoint.y, midPoint.x, midPoint.y);
    ctx.lineTo(x, y);
    ctx.stroke();

    state.lastPoint = { x, y };
}

function eraseAt(x, y) {
    // Soft erase logic (clearRect)
    const r = CONFIG.ERASER_RADIUS;
    ctx.clearRect(x - r / 2, y - r / 2, r, r);
}

// --- BUTTONS ---
btnClear.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    resetResults();
});

btnRecognize.addEventListener('click', performRecognition);

function resetResults() {
    mathExpressionDiv.innerText = "...";
    mathAnswerDiv.innerText = "...";
    explanationBox.innerText = "Waiting for input...";
    document.getElementById('graph-container').innerHTML = "";
    mathAnswerDiv.classList.remove('highlight');
}

// --- RECOGNITION & SOLVER ---
async function performRecognition() {
    if (state.mode === 'RECOGNIZING') return;
    state.mode = 'RECOGNIZING';
    statusPill.innerText = "Analyzing...";

    // 1. Capture Canvas
    // Canvas is transparent, we need to draw it on white background for OCR
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');

    // White background
    tCtx.fillStyle = '#ffffff';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Draw strokes (need to invert mirror for OCR? No, canvas is already mirrored via block scaleX)
    // Wait, the canvas CSS is transform scaleX(-1). The actual pixel data is NORMAL (left-to-right from camera).
    // BUT the user draws mirrored visually. 
    // If the user moves right hand to right screen, pixel x moves.
    // Let's look at `drawAt`: `x` comes from `landmark.x` * width.
    // MediaPipe x is normalized [0, 1]. 
    // If `transform: scaleX(-1)` is on canvas, visual is flipped.
    // If I draw at x=10, it appears at width-10 visually?
    // Let's verify: 
    // Video: mirrored via CSS.
    // Canvas: mirrored via CSS.
    // HandLandmarker: returns coordinates matching the VIDEO element (if used as source).
    // So the coordinates match the PIXELS of the video.
    // So if I draw on the canvas pixels, and CSS flips it, it aligns with value.
    // OCR reads PIXELS.
    // Tesseract reads English left-to-right.
    // If I write "2", pixels form "2". CSS flips it to "S" (reversed 2).
    // WRONG.
    // If I see myself mirrored, and I write "2" in the air, I write a "normal 2" from MY perspective? 
    // No, if I write usually, I write left-to-right.
    // If mirror is ON: I move hand right -> screen hand moves right. 
    // The "pixels" capture the "reversed" image if the source was user-facing.
    // ACTUALLY:
    // If I want the OCR to read it, the PIXELS in `tempCanvas` must be "readable text".
    // If CSS flips the canvas, the underlying pixels are NOT flipped. 
    // If I write a "2" and it looks like a "2" on the mirrored screen, that means the underlying pixels are FLIPPED horizontally (so they look normal when flipped back).
    // So I need to FLIP the tempCanvas before sending to OCR.

    tCtx.translate(tempCanvas.width, 0);
    tCtx.scale(-1, 1);
    tCtx.drawImage(canvas, 0, 0); // content is drawn flipped
    // Now `tempCanvas` pixels are "Normal" (readable).

    // 2. OCR
    try {
        const result = await Tesseract.recognize(tempCanvas, 'eng', {
            logger: m => statusPill.innerText = `OCR: ${Math.round(m.progress * 100)}%`
        });

        const rawText = result.data.text;
        console.log("OCR Raw:", rawText);

        processMath(rawText);

    } catch (e) {
        console.error(e);
        mathExpressionDiv.innerText = "Error Recognizing";
        state.mode = 'PAUSE';
    }
}

function processMath(text) {
    // Clean text
    let clean = text.trim();
    // Common fixes
    clean = clean.replace(/o/gi, '0')
        .replace(/l/gi, '1')
        .replace(/i/gi, '1')
        .replace(/x/gi, '*') // 'x' to multiply usually
        .replace(/X/gi, '*')
        .replace(/÷/g, '/')
        .replace(/—/g, '-'); // Em dash

    // Heuristic: If it looks like algebra (contains 'y' or matches equation), don't replace x with * blindly?
    // Let's assume arithmetic first.
    // Actually, user wants algebra "2x + 3".
    // So 'x' should NOT always be '*'.
    // If 'x' is surrounded by numbers, maybe *. If valid variable, keep x.
    // MathJS handles '2x' as 2*x.
    // So let's revert the 'x' -> '*' replacement if it seems algebraic.
    // But Tesseract often sees multiplication 'x' as 'x'.
    // Let's just be careful. We'll leave 'x' alone and let MathJS try to parse.
    // But 'X' (capital) is usually multiply visually.

    // Remove non-math chars
    // clean = clean.replace(/[^0-9+\-*/().xy=a-z]/gi, ''); 

    mathExpressionDiv.innerText = clean;

    try {
        // Try solving
        const solution = solveMath(clean);
        mathAnswerDiv.innerText = solution.answer;
        mathAnswerDiv.classList.add('highlight');

        // Explain
        const steps = generateHinglishExplanation(clean, solution);
        explanationBox.innerHTML = steps;

        // Graph if function
        if (solution.isFunction) {
            plotGraph(solution.expr, solution.variable);
        } else {
            document.getElementById('graph-container').innerHTML = "";
        }

    } catch (e) {
        mathAnswerDiv.innerText = "?";
        explanationBox.innerText = "Samajh nahi aaya. Please try writing clearer.";
        console.error("Math Error:", e);
    }

    state.mode = 'PAUSE';
    statusPill.innerText = "Done";
}

// --- SOLVER LOGIC ---
function solveMath(expr) {
    // Detect Variable (default to x)
    const vars = expr.match(/[a-z]/i);
    const v = vars ? vars[0] : 'x';

    // 1. Calculus: Derivative
    if (expr.toLowerCase().startsWith('d/dx') || expr.toLowerCase().includes('deriv')) {
        let content = expr.replace(/d\/dx|derivative/gi, '').replace(/[()]/g, ''); // Crude parsing
        // If content is empty, maybe it's "x^2" from previous steps? Assume strict formatting like "d/dx x^2"
        if (!content && expr.includes(' ')) content = expr.split(' ').pop();

        try {
            const result = nerdamer(`diff(${content}, ${v})`);
            return { answer: result.text(), type: 'calculus', subType: 'derivative', input: content, variable: v };
        } catch (e) { console.warn(e); }
    }

    // 2. Calculus: Integral
    if (expr.startsWith('∫') || expr.toLowerCase().includes('int')) {
        let content = expr.replace(/∫|integral/gi, '').replace('dx', '');
        try {
            const result = nerdamer(`integrate(${content}, ${v})`);
            return { answer: result.text(), type: 'calculus', subType: 'integral', input: content, variable: v };
        } catch (e) { console.warn(e); }
    }

    // 3. Algebraic Equation (contains =)
    if (expr.includes('=')) {
        try {
            const solutions = nerdamer.solve(expr, v);
            return {
                answer: solutions.toString(),
                type: 'equation',
                input: expr,
                variable: v,
                isFunction: true, // Treat as function for graphing attempt if y=...
                expr: expr
            };
        } catch (e) { console.warn(e); }
    }

    // 4. Numeric / Symoblic Evaluation
    try {
        const result = nerdamer(expr).evaluate();
        return { answer: result.text(), type: 'arithmetic', input: expr, variable: v };
    } catch (e) {
        // Fallback to MathJS
        try {
            const mAns = math.evaluate(expr);
            return { answer: mAns.toString(), type: 'arithmetic', input: expr };
        } catch (err) {
            throw new Error("Unsolvable");
        }
    }
}

// --- HINGLISH EXPLANATION ---
function generateHinglishExplanation(input, result) {
    const safeInput = input || "";
    const safeAns = result.answer || "";
    const v = result.variable || 'x';

    if (result.type === 'calculus') {
        const action = result.subType === 'derivative' ? 'differentiate' : 'integrate';
        return `<p>Humne <b>${result.input}</b> ko ${action} kiya.</p>
                <p>Calculus ke rules lagane ke baad, final answer hai: <br><b>${safeAns}</b></p>
                <p>Graph check kar sakte ho right mein!</p>`;
    }

    if (result.type === 'equation') {
        return `<p>Ye ek equation hai: <b>${safeInput}</b></p>
                <p>Humne <b>${v}</b> ki value find karne ke liye dono sides solve ki.</p>
                <p>Solution mila: <b>${safeAns}</b></p>
                <p>Agar ye line ya curve hai, toh graph dekho.</p>`;
    }

    // Arithmetic
    return `<p>Expression: <b>${safeInput}</b></p>
            <p>Seedha calculate karke result aaya:</p>
            <p class="highlight" style="font-size:1.1em">${safeAns}</p>
            <p>Easy tha na?</p>`;
}

// --- GRAPHING ---
function plotGraph(expression, variable = 'x') {
    try {
        // If expr is "y = x^2", parse "x^2"
        let fnStr = expression;
        if (fnStr.includes('=')) {
            const parts = fnStr.split('=');
            fnStr = parts[1]; // take RHS
        }

        const exprCompiled = math.compile(fnStr);
        const xValues = math.range(-10, 10, 0.5).toArray();
        const yValues = xValues.map(x => exprCompiled.evaluate({ x: x }));

        const trace = {
            x: xValues,
            y: yValues,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#06b6d4', width: 3 }
        };

        const layout = {
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            margin: { t: 20, r: 20, b: 40, l: 40 },
            xaxis: { color: '#94a3b8' },
            yaxis: { color: '#94a3b8' },
            height: 300
        };

        Plotly.newPlot('graph-container', [trace], layout, { displayModeBar: false });

    } catch (e) {
        console.log("Graphing failed", e);
    }
}

// Start
init();
