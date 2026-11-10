```javascript

import {
    HandLandmarker,
    FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/vision_bundle.js";


// DOM Elements
const video = document.getElementById("webcam");
const canvasElement = document.getElementById("output_canvas");
const canvasCtx = canvasElement.getContext("2d");
const statusBadge = document.getElementById("gesture_status");
const recognizeBtn = document.getElementById("recognizeBtn");
const clearBtn = document.getElementById("clearBtn");
const mathOutput = document.getElementById("math_output");
const explanationOutput = document.getElementById("explanation_output");

// State
let handLandmarker = undefined;
let webcamRunning = false;
let lastVideoTime = -1;
let results = undefined;

// Drawing State
let isDrawing = false;
let isErasing = false;
let lastX = 0;
let lastY = 0;
let strokeColor = "white";
let lineWidth = 4;

function debugLog(msg) {
    console.log(msg);
    const debugContainer = document.getElementById("debug_log");
    if (debugContainer) {
        const logItem = document.createElement("div");
        const time = new Date().toLocaleTimeString();
        logItem.innerText = "[" + time + "] " + msg;
        debugContainer.prepend(logItem); 
    }
    
    // Append to status for visibility if critical
    if (msg.includes("Error") || msg.includes("Failed")) {
        explanationOutput.innerText = "[System]: " + msg + "\n" + explanationOutput.innerText;
    }
}

// --- Initialization ---

async function createHandLandmarker() {
    debugLog("Loading MediaPipe HandLandmarker...");
    statusBadge.innerText = "⏳ Loading AI...";

    try {
        const vision = await FilesetResolver.forVisionTasks(
            "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
                delegate: "GPU"
            },
            runningMode: "VIDEO",
            numHands: 1
        });
        debugLog("HandLandmarker loaded successfully.");
        statusBadge.innerText = "✅ AI Ready. Starting Cam...";
        enableCam();
    } catch (e) {
        debugLog("Error loading MediaPipe: " + e.message);
        console.error(e);
        statusBadge.innerText = "❌ AI Load Failed";
        alert("Failed to load AI model. Check console/debug log.");
    }
}

function enableCam() {
    if (!handLandmarker) {
        debugLog("HandLandmarker not ready.");
        return;
    }

    const constraints = {
        video: {
            width: 1280,
            height: 720
        }
    };

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        video.srcObject = stream;
        video.addEventListener("loadeddata", () => {
            // Initial setup once data is loaded
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
            debugLog("Camera started: " + video.videoWidth + "x" + video.videoHeight);
            statusBadge.innerText = "✋ Show Hand to Draw";
            webcamRunning = true;
            predictWebcam();
        });
    }).catch(err => {
        debugLog("Camera Error: " + err);
        statusBadge.innerText = "❌ Camera Denied";
    });
}

// --- Frame Loop ---

async function predictWebcam() {
    // FIXED: Only resize if dimensions actually changed significantly or are 0
    if (video.videoWidth > 0 && video.videoHeight > 0) {
        if (canvasElement.width !== video.videoWidth || canvasElement.height !== video.videoHeight) {
            canvasElement.width = video.videoWidth;
            canvasElement.height = video.videoHeight;
            debugLog(`Canvas Resized: ${ canvasElement.width }x${ canvasElement.height } `);
        }
    }

    let startTimeMs = performance.now();
    if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        try {
            results = handLandmarker.detectForVideo(video, startTimeMs);
        } catch (e) {
            // debugLog("Detection error (ignoring): " + e);
        }
    }

    if (results && results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0]; // First hand
        processGestures(landmarks);
    } else {
        // Only update status if meaningful change to avoid flicker? 
        // Or just "Waiting..."
        // statusBadge.innerText = "Waiting for hand...";
        isDrawing = false;
        // Don't spam status updates
    }

    if (webcamRunning) {
        window.requestAnimationFrame(predictWebcam);
    }
}


// --- Gesture Logic ---

function processGestures(landmarks) {
    // Index tip: 8
    // Middle tip: 12
    // Ring tip: 16
    // Pinky tip: 20
    // Thumb tip: 4

    const indexTip = landmarks[8];
    const middleTip = landmarks[12];
    const ringTip = landmarks[16];
    const thumbTip = landmarks[4]; // Optional for pinch

    // Coordinates normalized [0,1]. Flip X because video is mirrored.
    // Wait, CSS mirrors the video element.
    // If we draw on canvas which is also mirrored via CSS, we can use raw text coords?
    // Actually, if we use values 0..1 from MediaPipe (which matches video source), 
    // and draw to canvas (width/height), it aligns with video source.
    // If BOTH are CSS flipped, they visually align to user. 

    const x = indexTip.x * canvasElement.width;
    const y = indexTip.y * canvasElement.height;

    // Simple Distance Check
    // Draw: Index extended, Middle closed.
    // Erase: Index + Middle extended.

    const isIndexExtended = indexTip.y < landmarks[6].y; // higher than pip
    const isMiddleExtended = middleTip.y < landmarks[10].y;
    const isRingExtended = ringTip.y < landmarks[14].y;

    if (isIndexExtended && isMiddleExtended && isRingExtended) {
        // ERASE MODE (Three fingers - Large Eraser)
        statusBadge.innerText = "🧹 Large Erase";
        isDrawing = false;
        eraseStroke(x, y, 50);
    } else if (isIndexExtended && isMiddleExtended) {
        // ERASE MODE (Two fingers - Standard Eraser)
        statusBadge.innerText = "🧹 Erasing";
        isDrawing = false;
        eraseStroke(x, y, 30);
    } else if (isIndexExtended && !isMiddleExtended && !isRingExtended) {
        // DRAW MODE
        statusBadge.innerText = "✏️ Drawing";
        if (!isDrawing) {
            isDrawing = true;
            lastX = x;
            lastY = y;
        }
        drawStroke(x, y);
        lastX = x;
        lastY = y;
    } else {
        // PAUSE / IDLE
        statusBadge.innerText = "✋ Paused";
        isDrawing = false;
    }
}

function drawStroke(x, y) {
    canvasCtx.beginPath();
    canvasCtx.moveTo(lastX, lastY);
    canvasCtx.lineTo(x, y);
    canvasCtx.strokeStyle = strokeColor;
    canvasCtx.lineWidth = lineWidth;
    canvasCtx.lineCap = "round";
    canvasCtx.stroke();
}

function eraseStroke(x, y, radius = 30) {
    canvasCtx.save();
    canvasCtx.globalCompositeOperation = 'destination-out';
    canvasCtx.beginPath();
    canvasCtx.arc(x, y, radius, 0, Math.PI * 2, false);
    canvasCtx.fill();
    canvasCtx.restore();
}

// --- Math & OCR ---


recognizeBtn.addEventListener('click', async () => {
    statusBadge.innerText = "⏳ Recognizing...";

    // 1. Pre-process Image for OCR
    // The canvas is internally mirrored (due to drawing logic matching CSS mirror).
    // And it has White ink on Transparent (looks black due to CSS BG).
    // Tesseract needs Black ink on White BG, and Un-mirrored text.

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasElement.width;
    tempCanvas.height = canvasElement.height;
    const tCtx = tempCanvas.getContext('2d');

    // Fill White Background
    tCtx.fillStyle = '#FFFFFF';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Prepare to Un-mirror: result = White BG. 
    // We want to draw the existing White Strokes as Black? 
    // Or invert later?
    // Let's draw the Mirrored White Strokes -> They appear as White on White. Bad.

    // Better strategy:
    // 1. Fill Black.
    // 2. Draw Mirrored White Strokes. (Result: Mirrored White on Black)
    // 3. Un-mirror (Flip Horizontal). (Result: Normal White on Black)
    // 4. Invert Colors. (Result: Normal Black on White)

    // Step 1: Fill Black
    tCtx.fillStyle = '#000000';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // Step 2 & 3: Draw Un-mirrored
    // We want to flip the source image.
    tCtx.save();
    tCtx.translate(tempCanvas.width, 0);
    tCtx.scale(-1, 1);
    tCtx.drawImage(canvasElement, 0, 0);
    tCtx.restore();

    // Now we have Un-mirrored White on Black.

    // Step 4: Invert to get Black on White
    // We can do this by getting image data
    const imgData = tCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
        // Invert RGB
        data[i] = 255 - data[i];     // R
        data[i + 1] = 255 - data[i + 1]; // G
        data[i + 2] = 255 - data[i + 2]; // B
        // Alpha is 255, keep it
    }
    tCtx.putImageData(imgData, 0, 0);

    // Debug: verify image visually if needed (append to body)
    // document.body.appendChild(tempCanvas);

    const dataURL = tempCanvas.toDataURL('image/png');

    // 2. OCR with Tesseract
    try {
        const { data: { text } } = await Tesseract.recognize(dataURL, 'eng', {
            tessedit_char_whitelist: '0123456789+-*/=()abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,^'
        });

        console.log("Raw OCR:", text);
        const cleanText = cleanOCRText(text);
        mathOutput.innerText = cleanText || "No math found";

        if (cleanText) {
            solveMath(cleanText);
        }

        statusBadge.innerText = "✅ Done";
    } catch (err) {
        console.error(err);
        statusBadge.innerText = "❌ Error";
    }
});



function cleanOCRText(text) {
    // Basic cleanup
    let t = text.trim();
    t = t.replace(/\n/g, " ");
    // Replace characters that look like numbers/operators
    t = t.replace(/O/g, "0");
    t = t.replace(/l/g, "1");
    t = t.replace(/I/g, "1");
    t = t.replace(/S/g, "5");
    t = t.replace(/Z/g, "2");
    t = t.replace(/B/g, "8");
    // Replace x/X with * ONLY if it looks like multiplication (surrounded by numbers)
    // But if it is "2x", we want to keep x. 
    // Simple heuristic: if we see "x" and no "=", treat as variable? 
    // Let's rely on user writing clearly for now, but fix obvious "2 x 3".
    t = t.replace(/(\d)\s*[xX]\s*(\d)/g, "$1 * $2");

    // Fix "2x" -> "2*x" for mathjs if needed, but mathjs handles implicit mul often.
    // Actually, let's keep 'x' as variable if it's not clearly multiplication.

    return t;
}

// --- Solving ---

function solveMath(expression) {
    try {
        let result;
        let explanation = "";

        // 1. Graphing Check (y = f(x))
        // We assume 'target' is y if not specified, or checks for "y=" or "f(x)="
        // Simple check: does it have 'x' variable?
        const hasX = /[xX]/.test(expression);
        const hasEquals = /=/.test(expression);

        if (hasX && !hasEquals) {
            // Assume it's a function to plot, like "x^2"
            plotGraph(expression);
            // Also try to simplify?
            try {
                const simplified = math.simplify(expression).toString();
                mathOutput.innerText = `Function: ${ expression } `;
                explanationOutput.innerText = `Yeh ek function hai. Iska simplified form hai: ${ simplified }.\nHumne iska graph right side mein plot kiya hai.`;
                return;
            } catch (e) { }
        }

        if (hasEquals) {
            // Equation: 2x + 3 = 9
            const sides = expression.split('=');
            if (sides.length === 2) {
                const lhs = sides[0].trim();
                const rhs = sides[1].trim();

                // Very basic linear solver for "ax + b = c"
                // We can use a library or just simple arithmetic steps for demo if clean.
                // For MVP, just explain it's an equation.
                mathOutput.innerText = expression;
                explanationOutput.innerText = `Yeh ek equation hai: "${lhs}" barabar "${rhs}".\nCurrently hum auto - solve support nahi kar rahe complex equations ke liye, lekin aap graph dekh sakte hain agar hum isse "y = ${lhs} - ${rhs}" maanein.`;

                // Try to plot difference
                plotGraph(`${ lhs } - (${ rhs })`);
                return;
            }
        }

        // 2. Numeric Calc
        result = math.evaluate(expression);
        mathOutput.innerText = `${ expression } = ${ result } `;

        // Hinglish Explanation
        explanation = `Humne expression "${expression}" calculate kiya.\n`;
        explanation += `Answer hai: ${ result }.\n`;
        explanation += `Yeh result basic mathematical rules follow karke nikala gaya hai.`;

        explanationOutput.innerText = explanation;

        // Clear graph if just a number
        Plotly.purge(document.getElementById('graph_container'));

    } catch (e) {
        mathOutput.innerText = expression + " (?)";
        explanationOutput.innerText = "Error: Samajh nahi aaya ya solve nahi ho paya. Please clear written text clearly.";
        console.error(e);
    }
}

function plotGraph(expr) {
    try {
        const exprCompiled = math.compile(expr);
        const xValues = math.range(-10, 10, 0.5).toArray();
        const yValues = xValues.map(x => {
            try { return exprCompiled.evaluate({ x: x, X: x }); } catch (e) { return NaN; }
        });

        const trace = {
            x: xValues,
            y: yValues,
            type: 'scatter',
            mode: 'lines',
            line: { color: '#38bdf8', width: 3 },
            name: 'f(x)'
        };

        const layout = {
            title: 'Graph of ' + expr,
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: '#cbd5e1' },
            xaxis: { gridcolor: '#334155' },
            yaxis: { gridcolor: '#334155' },
            margin: { t: 40, r: 20, l: 40, b: 40 }
        };

        Plotly.newPlot(document.getElementById('graph_container'), [trace], layout, { responsive: true });

    } catch (e) {
        console.error("Graph error", e);
    }
}


// --- Utilities ---

clearBtn.addEventListener('click', () => {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    mathOutput.innerText = "...";
    explanationOutput.innerText = "...";
});

// Start
createHandLandmarker();

