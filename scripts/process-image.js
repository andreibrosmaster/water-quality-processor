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

// Extract numeric value from OCR text
function extractNumericValue(text, parameter) {
  console.log(`Raw OCR text for ${parameter}: "${text}"`);
  
  // Clean the text - remove everything except digits, dots, and spaces
  let cleanText = text.replace(/[^\d.\s-]/g, ' ').trim();
  
  // Find all potential numeric values
  const numbers = cleanText.match(/\d+\.?\d*/g);
  
  if (!numbers || numbers.length === 0) {
    console.log(`No numbers found in OCR text for ${parameter}`);
    return "";
  }
  
  console.log(`Found numbers for ${parameter}:`, numbers);
  
  // Parameter-specific logic
  switch (parameter) {
    case 'pH':
      // pH is typically 0-14, look for values in this range
      const pHValues = numbers.filter(n => {
        const val = parseFloat(n);
        return val >= 0 && val <= 14;
      });
      return pHValues.length > 0 ? pHValues[0] : numbers[0];
      
    case 'temperature':
      // Temperature likely 0-50°C for water systems
      const tempValues = numbers.filter(n => {
        const val = parseFloat(n);
        return val >= 0 && val <= 50;
      });
      return tempValues.length > 0 ? tempValues[0] : numbers[0];
      
    case 'dissolvedOxygen':
      // Dissolved oxygen typically 0-20 mg/L
      const doValues = numbers.filter(n => {
        const val = parseFloat(n);
        return val >= 0 && val <= 20;
      });
      return doValues.length > 0 ? doValues[0] : numbers[0];
      
    case 'salinity':
      // Salinity can vary widely, prefer decimal values
      const salinityValues = numbers.filter(n => {
        const val = parseFloat(n);
        return val >= 0 && val <= 100; // Reasonable range for most applications
      });
      return salinityValues.length > 0 ? salinityValues[0] : numbers[0];
      
    default:
      return numbers[0];
  }
}

// Process image quadrants
async function processImage(imagePath) {
  console.log(`Processing image: ${imagePath}`);
  
  try {
    // Read image
    const imageBuffer = fs.readFileSync(imagePath);
    
    // Get image dimensions
    const { width, height } = await sharp(imageBuffer).metadata();
    console.log(`Image dimensions: ${width}x${height}`);
    
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
    
    // Process each quadrant
    const results = {};
    
    for (const [parameter, coordinates] of Object.entries(quadrants)) {
      console.log(`Processing ${parameter} quadrant...`);
      
      try {
        // Extract and preprocess quadrant
        const quadrantBuffer = await sharp(imageBuffer)
          .extract(coordinates)
          .greyscale()
          .normalize()
          .sharpen()
          .resize(coordinates.width * 2, coordinates.height * 2) // Upscale for better OCR
          .toBuffer();
        
        // Perform OCR
        const { data: { text } } = await Tesseract.recognize(quadrantBuffer, 'eng', {
          logger: info => {
            if (info.status === 'recognizing text') {
              console.log(`OCR ${parameter}: ${Math.round(info.progress * 100)}%`);
            }
          }
        });
        
        // Extract numeric value
        const numericValue = extractNumericValue(text, parameter);
        results[parameter] = numericValue;
        
        console.log(`${parameter}: "${numericValue}"`);
        
      } catch (error) {
        console.error(`Error processing ${parameter}:`, error.message);
        results[parameter] = "";
      }
    }
    
    return results;
    
  } catch (error) {
    console.error('Error processing image:', error.message);
    throw error;
  }
}

// Update Firebase Database
async function updateFirebase(unitId, data) {
  console.log(`Updating Firebase for ${unitId}:`, data);
  
  try {
    await admin.database().ref(`${unitId}`).update(data);
    console.log('Firebase updated successfully');
  } catch (error) {
    console.error('Error updating Firebase:', error.message);
    throw error;
  }
}

// Main function
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
  
  try {
    // Initialize Firebase
    initFirebase();
    
    // Extract unit ID from filename
    const unitId = extractUnitId(imagePath);
    console.log(`Unit ID: ${unitId}`);
    
    // Process image
    const results = await processImage(imagePath);
    
    // Update Firebase
    await updateFirebase(unitId, results);
    
    console.log('Processing completed successfully!');
    
  } catch (error) {
    console.error('Processing failed:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
