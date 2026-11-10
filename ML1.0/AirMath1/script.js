import {
    FilesetResolver,
    HandLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/vision_bundle.mjs";

// DOM Elements
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const loadingScreen = document.getElementById("loading-screen");
const handStatus = document.getElementById("hand-status");
const ocrResult = document.getElementById("ocr-result");
const mathSolution = document.getElementById("math-solution");
const clearBtn = document.getElementById("clear-btn");

// State
let handLandmarker = undefined;
let webcamRunning = false;
let lastVideoTime = -1;
let results = undefined;
let isDrawing = false;
let currentStroke = [];
let allStrokes = []; // Array of strokes, where a stroke is [ {x, y}, ... ]
let isProcessing = false;
let processingDebounceTimer = null;

// Configuration
const LINE_WIDTH = 4;
const STROKE_COLOR = "#00ffcc"; // Neon Cyan for better visibility

// === Initialization ===
async function createHandLandmarker() {
    try {
        console.log("Loading Vision Tasks...");
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
        );

        console.log("Loading HandLandmarker...");
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1,
            minHandDetectionConfidence: 0.6,
            minHandPresenceConfidence: 0.6,
            minTrackingConfidence: 0.6
        });

        // Warm up Tesseract worker
        console.log("Loading Tesseract...");
        try {
            await Tesseract.createWorker('eng');
        } catch (tessErr) {
            console.error("Tesseract failed to load, OCR might not work:", tessErr);
            // Non-critical, continue but warn? Or just log.
            // We'll let it slide so at least hand tracking works
        }

        loadingScreen.style.opacity = "0";
        setTimeout(() => {
            loadingScreen.style.display = "none";
        }, 500);

        enableCam();

    } catch (error) {
        console.error("Initialization Error:", error);
        const loaderContent = document.querySelector('.loader-content');
        if (loaderContent) {
            loaderContent.innerHTML = `
                <h2 style="color: #ef4444">Initialization Failed</h2>
                <p style="color: #fff">${error.message}</p>
                <p style="font-size: 0.8rem; margin-top: 10px; color: #94a3b8">Check console for details. Ensure you are online (first run).</p>
            `;
        }
    }
}

function enableCam() {
    if (!handLandmarker) {
        console.log("Wait! HandLandmarker not loaded yet.");
        return;
    }

    const constraints = {
        video: { width: 1280, height: 720, facingMode: "user" }
    };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        video.srcObject = stream;
        video.addEventListener("loadeddata", predictWebcam);
        webcamRunning = true;
    });
}

// === Main Loop ===
async function predictWebcam() {
    canvasElement.width = video.videoWidth;
    canvasElement.height = video.videoHeight;

    let startTimeMs = performance.now();

    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        results = handLandmarker.detectForVideo(video, startTimeMs);
    }

    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Draw all previous strokes
    drawAllStrokes();

    if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0];

        // --- Hand Logic ---
        // Coordinates: Invert X for mirror effect
        const rawX = landmarks[8].x;
        const rawY = landmarks[8].y;

        // Mirror Logic:
        // Video is CSS flipped (scaleX(-1)).
        // We want the drawing to appear where the hand *appears* to be.
        // If rawX is 0 (Left edge of camera sensor), flipped video shows it on Right.
        // So we want x to be 1.0 (Right).
        const x = (1 - rawX) * canvasElement.width;
        const y = rawY * canvasElement.height;

        // Gesture Detection
        // Index Tip: 8, Index DIP: 7.
        // Check if Index is extended: Tip y < PIP y (assuming hand is upright)
        // Check if others are closed: Tip > PIP

        const indexExtended = landmarks[8].y < landmarks[6].y;
        const middleFolded = landmarks[12].y > landmarks[10].y;
        const ringFolded = landmarks[16].y > landmarks[14].y;
        const pinkyFolded = landmarks[20].y > landmarks[18].y;

        // Pinch (Touch Index to Thumb): dist(8, 4) < threshold
        const dx = landmarks[8].x - landmarks[4].x;
        const dy = landmarks[8].y - landmarks[4].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const isPinch = dist < 0.05;

        // States
        const isPointing = indexExtended && middleFolded && ringFolded && pinkyFolded;
        const isFist = !indexExtended && middleFolded && ringFolded && pinkyFolded; // Rough approximation
        const isPalmOpen = !middleFolded && !ringFolded && !pinkyFolded;

        // Cursor Visual
        canvasCtx.beginPath();
        canvasCtx.arc(x, y, 8, 0, 2 * Math.PI);

        // State Machine
        if (isPointing && !isProcessing) {
            // DRAW MODE
            canvasCtx.fillStyle = "#00ffcc";
            canvasCtx.shadowBlur = 10;
            canvasCtx.shadowColor = "#00ffcc";

            handStatus.innerHTML = '<i class="fa-solid fa-pen"></i> Drawing';

            if (!isDrawing) {
                // Start new stroke
                isDrawing = true;
                currentStroke = [];
            }
            currentStroke.push({ x, y });

        } else if (isFist || isPinch) {
            // STOP/PROCESS MODE
            canvasCtx.fillStyle = "#ef4444";
            canvasCtx.shadowBlur = 0;

            handStatus.innerHTML = '<i class="fa-regular fa-hand-rock"></i> Processing';

            if (isDrawing) {
                // Just ended a stroke
                isDrawing = false;
                if (currentStroke.length > 5) {
                    allStrokes.push(smoothStroke(currentStroke));
                }
                currentStroke = [];

                // Debounce processing to avoid accidental triggers
                clearTimeout(processingDebounceTimer);
                processingDebounceTimer = setTimeout(() => {
                    if (!isProcessing && allStrokes.length > 0) {
                        processMath();
                    }
                }, 1000); // Wait 1 second of "Fist" to trigger solve
            }

        } else {
            // HOVER MODE
            canvasCtx.fillStyle = "#facc15"; // Yellow
            canvasCtx.shadowBlur = 0;
            handStatus.innerHTML = '<i class="fa-solid fa-hand"></i> Hover';

            if (isDrawing) {
                isDrawing = false;
                if (currentStroke.length > 5) {
                    allStrokes.push(smoothStroke(currentStroke));
                }
                currentStroke = [];
            }
        }

        canvasCtx.fill();

    } else {
        handStatus.innerHTML = '<i class="fa-solid fa-hand-holding"></i> No Hand';
        if (isDrawing) {
            isDrawing = false;
            if (currentStroke.length > 5) allStrokes.push(smoothStroke(currentStroke));
            currentStroke = [];
        }
    }

    // Draw Current Stroke Live
    if (isDrawing && currentStroke.length > 1) {
        drawStroke(currentStroke, true);
    }

    canvasCtx.restore();

    if (webcamRunning) {
        window.requestAnimationFrame(predictWebcam);
    }
}

// === Drawing Helpers ===

function smoothStroke(stroke) {
    // Simple averaging smoothing or Douglas-Peucker could be used
    // For now, let's keep it raw but maybe skip close points
    return stroke;
}

function drawAllStrokes() {
    canvasCtx.lineWidth = LINE_WIDTH;
    canvasCtx.lineCap = "round";
    canvasCtx.lineJoin = "round";
    canvasCtx.strokeStyle = STROKE_COLOR;
    canvasCtx.shadowBlur = 5;
    canvasCtx.shadowColor = STROKE_COLOR;

    allStrokes.forEach(stroke => {
        drawStroke(stroke, false);
    });
}

function drawStroke(points, isLive) {
    if (points.length < 2) return;

    canvasCtx.beginPath();
    canvasCtx.moveTo(points[0].x, points[0].y);

    // Quadratic Bezier Smoothing
    for (let i = 1; i < points.length - 2; i++) {
        const c = (points[i].x + points[i + 1].x) / 2;
        const d = (points[i].y + points[i + 1].y) / 2;
        canvasCtx.quadraticCurveTo(points[i].x, points[i].y, c, d);
    }

    // Connect the last few points
    for (let i = Math.max(1, points.length - 2); i < points.length; i++) {
        canvasCtx.lineTo(points[i].x, points[i].y);
    }

    canvasCtx.stroke();
}

// === Math Logic ===

async function processMath() {
    if (isProcessing) return;
    isProcessing = true;

    // 1. Prepare high-contrast image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasElement.width;
    tempCanvas.height = canvasElement.height;
    const ctx = tempCanvas.getContext('2d');

    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "black";

    allStrokes.forEach(stroke => {
        if (stroke.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length - 2; i++) {
            const c = (stroke[i].x + stroke[i + 1].x) / 2;
            const d = (stroke[i].y + stroke[i + 1].y) / 2;
            ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, c, d);
        }
        for (let i = Math.max(1, stroke.length - 2); i < stroke.length; i++) {
            ctx.lineTo(stroke[i].x, stroke[i].y);
        }
        ctx.stroke();
    });

    // 2. OCR RECOGNITION
    ocrResult.innerHTML = '<span class="loading-dots">Analyzing</span>';
    mathSolution.innerText = "...";

    try {
        const { data: { text } } = await Tesseract.recognize(tempCanvas, 'eng', {
            tessedit_char_whitelist: '0123456789xyz+-=/*()sincostanlogexp^sqrt.,de' // Added d, e for calculus/exp
        });

        console.log("OCR Output:", text);
        let cleaned = cleanEquation(text);

        if (cleaned) {
            ocrResult.innerText = cleaned;
            solveWithNerdamer(cleaned);
        } else {
            ocrResult.innerText = "No math detected";
            isProcessing = false;
        }
    } catch (e) {
        console.error(e);
        ocrResult.innerText = "Error";
        isProcessing = false;
    }
}

function cleanEquation(text) {
    let s = text.toLowerCase().trim();
    s = s.replace(/\n/g, "");
    s = s.replace(/\s/g, ""); // remove spaces

    // OCR Common Fixes
    s = s.replace(/l/g, "1");
    s = s.replace(/o/g, "0");
    s = s.replace(/i/g, "1");
    s = s.replace(/“/g, "");
    s = s.replace(/”/g, "");

    // Smart Multiplication using 'x'
    // If 'x' is surrounded by numbers (e.g. 2x2), treat as *
    s = s.replace(/(\d)x(\d)/g, "$1*$2");

    // If 'x' is at the start or end of a number but not part of a function?
    // Hard to tell. Let's stick to the safe "between numbers" rule.
    // Also support 'X' if OCR returns caps (though we lowercased it)

    // Division: sometimes '/' is read as '7' or '1' depending on font, but Tesseract is okay with /.
    // Ensure standard operators
    s = s.replace(/÷/g, "/");
    s = s.replace(/—/g, "-"); // Em dash to minus

    return s;
}

function solveWithNerdamer(expression) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height); // Optional: Auto clear? No, user might want to see.

    try {
        // Detect Type
        let result = "";

        // 1. Solving Equation (has =)
        if (expression.includes("=")) {
            // expression: "2x+3=7"
            // nerdamer.solve(eqn, x)
            const parts = expression.split("=");
            // Form: part1 - part2 = 0
            const eqn = `${parts[0]}-(${parts[1]})`;
            const solution = nerdamer.solve(eqn, 'x');
            result = `x = ${solution.toString()}`;

            // Plot left and right?
            drawGraph([parts[0], parts[1]]);

        } else if (expression.startsWith("d/dx") || expression.includes("derivative")) {
            // Derivative
            // remove "d/dx"
            const body = expression.replace("d/dx", "").replace(/\(|\)/g, ""); // naive cleanup
            const res = nerdamer(`diff(${body}, x)`);
            result = res.toString();
            drawGraph(result);

        } else if (expression.startsWith("int") || expression.includes("integral")) {
            // Integral
            const body = expression.replace("int", "").replace("dx", "");
            const res = nerdamer(`integrate(${body}, x)`);
            result = res.toString();

        } else {
            // Evaluation or Simplify
            // Check if function of x
            if (expression.includes('x')) {
                // Simplify
                result = nerdamer(expression).toString();
                drawGraph([expression]);
            } else {
                // Numeric
                const val = nerdamer(expression).evaluate();
                result = val.text();
            }
        }

        mathSolution.innerText = result;

    } catch (err) {
        console.error("Nerdamer Error:", err);
        // Fallback to MathJS evaluate for simple arithmetic if nerdamer failed
        try {
            const val = math.evaluate(expression);
            mathSolution.innerText = val;
        } catch (e2) {
            mathSolution.innerText = "Could not solve";
        }
    }

    isProcessing = false;
}

function drawGraph(expressions) {
    // expressions is array of strings e.g. ["x^2", "x+2"]

    try {
        const data = [];
        const xValues = [];
        for (let i = -10; i <= 10; i += 0.5) xValues.push(i);

        expressions.forEach((exprStr, idx) => {
            // Nerdamer to parse and eval
            try {
                // Create function
                const f = nerdamer(exprStr).buildFunction(['x']);
                const yValues = xValues.map(x => {
                    try { return f(x); } catch (e) { return null; }
                });

                data.push({
                    x: xValues,
                    y: yValues,
                    type: 'scatter',
                    mode: 'lines',
                    name: exprStr,
                    line: { width: 3 }
                });
            } catch (e) { console.log("Graph gen error for", exprStr); }
        });

        if (data.length > 0) {
            const layout = {
                margin: { t: 20, r: 20, b: 40, l: 40 },
                paper_bgcolor: 'rgba(0,0,0,0)',
                plot_bgcolor: 'rgba(0,0,0,0)',
                xaxis: { gridcolor: '#334155' },
                yaxis: { gridcolor: '#334155' },
                showlegend: true,
                legend: { x: 0, y: 1, font: { color: 'white' } },
                font: { color: "#94a3b8" }
            };
            Plotly.newPlot('plot-area', data, layout, { responsive: true, displayModeBar: false });
        }

    } catch (e) {
        console.error("Plotly error", e);
    }
}

clearBtn.addEventListener('click', () => {
    allStrokes = [];
    currentStroke = [];
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    ocrResult.innerText = "Waiting...";
    mathSolution.innerText = "---";
    Plotly.purge('plot-area');
    isProcessing = false;
    handStatus.innerHTML = '<i class="fa-solid fa-hand"></i> Ready';
});

// Start
createHandLandmarker();

// Register Service Worker for Offline Support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered'))
            .catch(err => console.log('Service Worker registration failed: ', err));
    });
}
