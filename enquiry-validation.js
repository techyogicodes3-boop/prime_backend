const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function enquiryValidationError({name, email, phone, message}) {
  if (name.length < 2) return 'Please enter your name.';
  if (!email && !phone) return 'Please enter your email address or mobile number.';
  if (email && !emailPattern.test(email)) return 'Please enter a valid email address.';
  if (phone && !/^\d{10}$/.test(phone)) return 'Mobile number must contain exactly 10 digits.';
  if (message.length < 10) return 'Please enter a message of at least 10 characters.';
  return '';
}
