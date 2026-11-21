/* Used only with the pinned Node loopback test fixtures; seccomp and Landlock
 * still enforce socket families and ports. This is not a network namespace. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <sys/socket.h>

static int allowed(const struct sockaddr *address, socklen_t length) {
  return address && length >= sizeof(struct sockaddr_in) &&
         address->sa_family == AF_INET &&
         ((const struct sockaddr_in *)address)->sin_addr.s_addr == htonl(INADDR_LOOPBACK);
}

int connect(int fd, const struct sockaddr *address, socklen_t length) {
  int (*real_connect)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "connect");
  if (real_connect && allowed(address, length)) return real_connect(fd, address, length);
  errno = EPERM;
  return -1;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  int (*real_bind)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_NEXT, "bind");
  if (real_bind && allowed(address, length)) return real_bind(fd, address, length);
  errno = EPERM;
  return -1;
}
