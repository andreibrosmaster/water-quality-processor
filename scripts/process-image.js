const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const admin = require('firebase-admin');

// Initialize Firebase Admin
function initFirebase() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL
    });
  }
}

// Extract unit ID from filename
function extractUnitId(filename) {
  // Expected format: unit_1_20250105_143022.jpg or just unit_1.jpg
  const basename = path.basename(filename, path.extname(filename));
  const parts = basename.split('_');
  
  if (parts.length >= 2) {
    return `${parts[0]}_${parts[1]}`; // unit_1, unit_2, etc.
  }
  
  // Fallback: try to extract unit number
  const match = basename.match(/unit[_\s]*(\d+)/i);
  return match ? `unit_${match[1]}` : 'unit_1';
}

// Extract numeric value from OCR text with improved accuracy
function extractNumericValue(text, parameter) {
  console.log(`Raw OCR text for ${parameter}: "${text}"`);
  
  // Clean the text - remove everything except digits, dots, spaces, and minus signs
  let cleanText = text.replace(/[^\d.\s-]/g, ' ').trim();
  
  // Find all potential numeric values including decimals and negative numbers
  const numbers = cleanText.match(/-?\d+\.?\d*/g);
  
  if (!numbers || numbers.length === 0) {
    console.log(`No numbers found in OCR text for ${parameter}`);
    return "0.00";
  }
  
  console.log(`Found numbers for ${parameter}:`, numbers);
  
  // Convert to floats and filter based on parameter ranges
  const validNumbers = numbers.map(n => parseFloat(n)).filter(n => !isNaN(n));
  
  if (validNumbers.length === 0) {
    console.log(`No valid numbers found for ${parameter}`);
    return "0.00";
  }
  
  // Parameter-specific logic with improved ranges
  let selectedValue;
  switch (parameter) {
    case 'pH':
      // pH is typically 0-14, look for values in this range
      const pHValues = validNumbers.filter(n => n >= 0 && n <= 14);
      selectedValue = pHValues.length > 0 ? pHValues[0] : validNumbers[0];
      break;
      
    case 'temperature':
      // Temperature likely -10 to 60°C for various water systems
      const tempValues = validNumbers.filter(n => n >= -10 && n <= 60);
      selectedValue = tempValues.length > 0 ? tempValues[0] : validNumbers[0];
      break;
      
    case 'dissolvedOxygen':
      // Dissolved oxygen typically 0-25 mg/L
      const doValues = validNumbers.filter(n => n >= 0 && n <= 25);
      selectedValue = doValues.length > 0 ? doValues[0] : validNumbers[0];
      break;
      
    case 'salinity':
      // Salinity can vary widely, 0-50 ppt for most applications
      const salinityValues = validNumbers.filter(n => n >= 0 && n <= 50);
      selectedValue = salinityValues.length > 0 ? salinityValues[0] : validNumbers[0];
      break;
      
    default:
      selectedValue = validNumbers[0];
  }
  
  // Format to 2 decimal places
  return selectedValue.toFixed(2);
}

// Process image quadrants with enhanced preprocessing
async function processImage(imagePath) {
  console.log(`Processing image: ${imagePath}`);
  
  try {
    // Read image with enhanced metadata
    const imageBuffer = fs.readFileSync(imagePath);
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height, format, density } = metadata;
    
    console.log(`Image: ${width}x${height}, Format: ${format}, Density: ${density || 'unknown'}`);
    
    const halfWidth = Math.floor(width / 2);
    const halfHeight = Math.floor(height / 2);
    
    // Define quadrants based on cartesian plane
    const quadrants = {
      // Quadrant 1: Top Right (Temperature)
      temperature: {
        left: halfWidth,
        top: 0,
        width: halfWidth,
        height: halfHeight
      },
      // Quadrant 2: Top Left (pH)
      pH: {
        left: 0,
        top: 0,
        width: halfWidth,
        height: halfHeight
      },
      // Quadrant 3: Bottom Left (Dissolved Oxygen)
      dissolvedOxygen: {
        left: 0,
        top: halfHeight,
        width: halfWidth,
        height: halfHeight
      },
      // Quadrant 4: Bottom Right (Salinity)
      salinity: {
        left: halfWidth,
        top: halfHeight,
        width: halfWidth,
        height: halfHeight
      }
    };
    
    // Process each quadrant with multiple preprocessing strategies
    const results = {};
    const processingPromises = [];
    
    for (const [parameter, coordinates] of Object.entries(quadrants)) {
      const promise = (async () => {
        console.log(`Processing ${parameter} quadrant...`);
        
        try {
          // Strategy 1: Basic preprocessing
          const basicBuffer = await sharp(imageBuffer)
            .extract(coordinates)
            .greyscale()
            .normalize()
            .resize(coordinates.width * 2, coordinates.height * 2, {
              kernel: sharp.kernel.lanczos3
            })
            .toBuffer();
          
          // Strategy 2: High contrast preprocessing
          const contrastBuffer = await sharp(imageBuffer)
            .extract(coordinates)
            .greyscale()
            .normalize()
            .linear(2.0, -50) // High contrast
            .sharpen({ sigma: 2.0 })
            .resize(coordinates.width * 2, coordinates.height * 2, {
              kernel: sharp.kernel.lanczos3
            })
            .toBuffer();
          
          // Strategy 3: Threshold preprocessing for clear digits
          const thresholdBuffer = await sharp(imageBuffer)
            .extract(coordinates)
            .greyscale()
            .normalize()
            .threshold(128) // Binary threshold
            .resize(coordinates.width * 2, coordinates.height * 2, {
              kernel: sharp.kernel.lanczos3
            })
            .toBuffer();
          
          // Try OCR with different preprocessing strategies
          const ocrPromises = [
            Tesseract.recognize(basicBuffer, 'eng', {
              logger: info => {
                if (info.status === 'recognizing text') {
                  console.log(`OCR ${parameter} (basic): ${Math.round(info.progress * 100)}%`);
                }
              },
              tessedit_char_whitelist: '0123456789.-',
              tessedit_pageseg_mode: '8' // SINGLE_WORD
            }),
            Tesseract.recognize(contrastBuffer, 'eng', {
              logger: info => {
                if (info.status === 'recognizing text') {
                  console.log(`OCR ${parameter} (contrast): ${Math.round(info.progress * 100)}%`);
                }
              },
              tessedit_char_whitelist: '0123456789.-',
              tessedit_pageseg_mode: '8' // SINGLE_WORD
            }),
            Tesseract.recognize(thresholdBuffer, 'eng', {
              logger: info => {
                if (info.status === 'recognizing text') {
                  console.log(`OCR ${parameter} (threshold): ${Math.round(info.progress * 100)}%`);
                }
              },
              tessedit_char_whitelist: '0123456789.-',
              tessedit_pageseg_mode: '8' // SINGLE_WORD
            })
          ];
          
          // Wait for all OCR attempts
          const ocrResults = await Promise.all(ocrPromises);
          
          // Combine all OCR results and find the best one
          const allTexts = ocrResults.map(result => result.data.text);
          let bestValue = "0.00";
          let bestConfidence = 0;
          
          for (let i = 0; i < allTexts.length; i++) {
            const text = allTexts[i];
            const confidence = ocrResults[i].data.confidence;
            
            console.log(`OCR ${parameter} strategy ${i+1}: "${text}" (confidence: ${confidence})`);
            
            // Try to extract numeric value
            const numericValue = extractNumericValue(text, parameter);
            
            // If we got a valid number (not 0.00) and confidence is decent, use it
            if (numericValue !== "0.00" && confidence > bestConfidence) {
              bestValue = numericValue;
              bestConfidence = confidence;
            } else if (bestValue === "0.00" && numericValue !== "0.00") {
              // If we haven't found anything yet, take any valid number
              bestValue = numericValue;
              bestConfidence = confidence;
            }
          }
          
          results[parameter] = bestValue;
          console.log(`${parameter}: "${bestValue}" (best confidence: ${bestConfidence})`);
          
        } catch (error) {
          console.error(`Error processing ${parameter}:`, error.message);
          results[parameter] = "0.00";
        }
      })();
      
      processingPromises.push(promise);
    }
    
    // Wait for all quadrants to be processed
    await Promise.all(processingPromises);
    
    return results;
    
  } catch (error) {
    console.error('Error processing image:', error.message);
    throw error;
  }
}

// Update Firebase Database with timestamp
async function updateFirebase(unitId, data) {
  const timestamp = new Date().toISOString();
  const dataWithTimestamp = {
    ...data,
    lastUpdated: timestamp,
    processedAt: admin.database.ServerValue.TIMESTAMP
  };
  
  console.log(`Updating Firebase for ${unitId}:`, dataWithTimestamp);
  
  try {
    await admin.database().ref(`${unitId}`).update(dataWithTimestamp);
    console.log('Firebase updated successfully');
  } catch (error) {
    console.error('Error updating Firebase:', error.message);
    throw error;
  }
}

// Main function with error handling
async function main() {
  const imagePath = process.argv[2];
  
  if (!imagePath) {
    console.error('Usage: node process-image.js <image-path>');
    process.exit(1);
  }
  
  if (!fs.existsSync(imagePath)) {
    console.error(`Image file not found: ${imagePath}`);
    process.exit(1);
  }
  
  const startTime = Date.now();
  
  try {
    console.log('🚀 Starting water quality image processing...');
    
    // Initialize Firebase
    initFirebase();
    
    // Extract unit ID from filename
    const unitId = extractUnitId(imagePath);
    console.log(`📊 Unit ID: ${unitId}`);
    
    // Process image
    const results = await processImage(imagePath);
    
    // Update Firebase
    await updateFirebase(unitId, results);
    
    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Processing completed successfully in ${processingTime}s!`);
    
  } catch (error) {
    console.error('❌ Processing failed:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
