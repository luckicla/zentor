package android.os;

public final class Process {
    public static final int THREAD_PRIORITY_BACKGROUND = 10;
    public static void setThreadPriority(int p) {}
    public static void setThreadPriority(int tid, int p) {}
    public static int getThreadPriority(int tid) { return 0; }
    public static int myTid() { return 0; }
}
