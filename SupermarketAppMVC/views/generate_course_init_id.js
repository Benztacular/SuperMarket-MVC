// This file to be removed for non-coursework use cases
const fs = require('fs');
const path = require('path');

// Use dynamic import for ESM-only uuid
let uuidv4;
async function getUuidV4() {
  if (!uuidv4) {
    const uuid = await import('uuid');
    uuidv4 = uuid.v4;
  }
  return uuidv4;
}

async function generateCourseInitId() {
  const courseInitIdFilePath = path.join(__dirname, 'course_init_id.js');
  
  if (fs.existsSync(courseInitIdFilePath)) {
    console.log('✓ Course ID file already exists. Skipping creation.');
    return;
  }

  const uuidv4Func = await getUuidV4();
  const courseInitId = uuidv4Func();
  const fileContent = `// This file to be removed for non-coursework use cases
export const courseInitId = '${courseInitId}';`;

  try {
    fs.writeFileSync(courseInitIdFilePath, fileContent, { mode: 0o444 });
    console.log(`✓ Course ID file created: ${courseInitId}`);
    fs.chmodSync(courseInitIdFilePath, 0o444);
  } catch (error) {
    console.error('Error creating course ID file:', error.message);
  }
}

(async () => {
  await generateCourseInitId();
})();