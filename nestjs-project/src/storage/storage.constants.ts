// Two clients (TD-04): the internal one talks to storage inside the Compose
// network; the public one only signs URLs that the browser opens.
export const S3_CLIENT = Symbol('S3_CLIENT');
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');
