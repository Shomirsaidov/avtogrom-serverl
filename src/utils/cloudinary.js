import { v2 as cloudinary } from 'cloudinary';

export function uploadToCloudinary(fileBase64, options = {}) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(fileBase64, options, (error, result) => {
      if (error) return reject(error);
      resolve({
        url: result.secure_url,
        public_id: result.public_id,
      });
    });
  });
}
