#define GL_SILENCE_DEPRECATION
#include <GLFW/glfw3.h>
#include <OpenGL/gl.h>
#include <vulkan/vulkan.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum { image_width = 1920, image_height = 1080, state_size = 1024 };

typedef struct {
    VkInstance instance;
    VkPhysicalDevice physical;
    VkDevice device;
    VkQueue queue;
    uint32_t family;
    VkBuffer storage;
    VkBuffer readback;
    VkDeviceMemory storage_memory;
    VkDeviceMemory readback_memory;
    uint8_t *state;
    uint8_t *pixels;
    VkImage image;
    VkDeviceMemory image_memory;
    VkImageView view;
    VkRenderPass render_pass;
    VkFramebuffer framebuffer;
    VkDescriptorSetLayout set_layout;
    VkPipelineLayout pipeline_layout;
    VkDescriptorPool descriptor_pool;
    VkDescriptorSet descriptor_set;
    VkPipeline graphics;
    VkPipeline compute;
    VkCommandPool command_pool;
    VkCommandBuffer command;
    size_t storage_size;
} Renderer;

static void fail(const char *message, int line) {
    fprintf(stderr, "mintbrew desktop: %s (line %d)\n", message, line);
    exit(1);
}

#define REQUIRE(expr) do { if (!(expr)) fail(#expr, __LINE__); } while (0)
#define VULKAN(expr) do { VkResult result = (expr); if (result != VK_SUCCESS) { fprintf(stderr, "mintbrew desktop: %s returned %d\n", #expr, result); exit(1); } } while (0)

static void *read_file(const char *path, size_t *length) {
    FILE *file = fopen(path, "rb");
    REQUIRE(file);
    REQUIRE(fseek(file, 0, SEEK_END) == 0);
    long size = ftell(file);
    REQUIRE(size > 0 && size <= 16 * 1024 * 1024);
    rewind(file);
    void *data = malloc((size_t)size);
    REQUIRE(data && fread(data, 1, (size_t)size, file) == (size_t)size);
    fclose(file);
    *length = (size_t)size;
    return data;
}

static uint32_t word(const uint8_t *bytes, size_t offset) {
    uint32_t value;
    memcpy(&value, bytes + offset, sizeof(value));
    return value;
}

static void put_word(uint8_t *bytes, size_t offset, uint32_t value) {
    memcpy(bytes + offset, &value, sizeof(value));
}

static void put_float(uint8_t *bytes, size_t offset, float value) {
    memcpy(bytes + offset, &value, sizeof(value));
}

static uint32_t memory_type(Renderer *r, uint32_t bits, VkMemoryPropertyFlags flags) {
    VkPhysicalDeviceMemoryProperties properties;
    vkGetPhysicalDeviceMemoryProperties(r->physical, &properties);
    for (uint32_t i = 0; i < properties.memoryTypeCount; i++) {
        if ((bits & (1u << i)) && (properties.memoryTypes[i].propertyFlags & flags) == flags)
            return i;
    }
    fail("no suitable Vulkan memory type", __LINE__);
    return 0;
}

static VkDeviceMemory allocate(Renderer *r, VkMemoryRequirements requirements, VkMemoryPropertyFlags flags) {
    VkMemoryAllocateInfo info = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize = requirements.size,
        .memoryTypeIndex = memory_type(r, requirements.memoryTypeBits, flags)
    };
    VkDeviceMemory memory;
    VULKAN(vkAllocateMemory(r->device, &info, NULL, &memory));
    return memory;
}

static VkBuffer create_buffer(Renderer *r, size_t size, VkBufferUsageFlags usage,
                              VkDeviceMemory *memory, uint8_t **mapped) {
    VkBufferCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
        .size = size,
        .usage = usage,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE
    };
    VkBuffer buffer;
    VULKAN(vkCreateBuffer(r->device, &info, NULL, &buffer));
    VkMemoryRequirements requirements;
    vkGetBufferMemoryRequirements(r->device, buffer, &requirements);
    *memory = allocate(r, requirements, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    VULKAN(vkBindBufferMemory(r->device, buffer, *memory, 0));
    VULKAN(vkMapMemory(r->device, *memory, 0, size, 0, (void **)mapped));
    return buffer;
}

static VkShaderModule load_shader(Renderer *r, const char *path) {
    size_t length;
    void *code = read_file(path, &length);
    REQUIRE((length & 3u) == 0);
    VkShaderModuleCreateInfo info = {
        .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
        .codeSize = length,
        .pCode = code
    };
    VkShaderModule module;
    VULKAN(vkCreateShaderModule(r->device, &info, NULL, &module));
    free(code);
    return module;
}

static int has_extension(const VkExtensionProperties *extensions, uint32_t count, const char *name) {
    for (uint32_t i = 0; i < count; i++)
        if (strcmp(extensions[i].extensionName, name) == 0) return 1;
    return 0;
}

static void create_device(Renderer *r) {
    VkApplicationInfo app = {
        .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
        .pApplicationName = "MintBrew desktop preview",
        .apiVersion = VK_API_VERSION_1_0
    };
    uint32_t extension_count = 0;
    VULKAN(vkEnumerateInstanceExtensionProperties(NULL, &extension_count, NULL));
    VkExtensionProperties *extensions = calloc(extension_count, sizeof(*extensions));
    REQUIRE(extensions);
    VULKAN(vkEnumerateInstanceExtensionProperties(NULL, &extension_count, extensions));
    REQUIRE(has_extension(extensions, extension_count, VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME));
    const char *instance_extensions[] = { VK_KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME };
    VkInstanceCreateInfo instance_info = {
        .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
        .flags = VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR,
        .pApplicationInfo = &app,
        .enabledExtensionCount = 1,
        .ppEnabledExtensionNames = instance_extensions
    };
    VULKAN(vkCreateInstance(&instance_info, NULL, &r->instance));
    free(extensions);

    uint32_t count = 0;
    VULKAN(vkEnumeratePhysicalDevices(r->instance, &count, NULL));
    REQUIRE(count > 0 && count < 32);
    VkPhysicalDevice devices[32];
    VULKAN(vkEnumeratePhysicalDevices(r->instance, &count, devices));
    r->physical = devices[0];
    for (uint32_t i = 0; i < count; i++) {
        VkPhysicalDeviceProperties properties;
        vkGetPhysicalDeviceProperties(devices[i], &properties);
        if (properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU ||
            properties.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) {
            r->physical = devices[i];
            break;
        }
    }
    VkPhysicalDeviceProperties properties;
    vkGetPhysicalDeviceProperties(r->physical, &properties);
    fprintf(stderr, "mintbrew desktop: Vulkan device %s\n", properties.deviceName);

    vkGetPhysicalDeviceQueueFamilyProperties(r->physical, &count, NULL);
    REQUIRE(count > 0 && count < 64);
    VkQueueFamilyProperties families[64];
    vkGetPhysicalDeviceQueueFamilyProperties(r->physical, &count, families);
    r->family = 0;
    while (r->family < count &&
           (families[r->family].queueFlags & (VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT)) !=
           (VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT)) r->family++;
    REQUIRE(r->family < count);

    uint32_t device_extension_count = 0;
    VULKAN(vkEnumerateDeviceExtensionProperties(r->physical, NULL, &device_extension_count, NULL));
    VkExtensionProperties *device_extensions = calloc(device_extension_count, sizeof(*device_extensions));
    REQUIRE(device_extensions);
    VULKAN(vkEnumerateDeviceExtensionProperties(r->physical, NULL, &device_extension_count, device_extensions));
    const char *device_names[1];
    uint32_t enabled = 0;
    if (has_extension(device_extensions, device_extension_count, "VK_KHR_portability_subset"))
        device_names[enabled++] = "VK_KHR_portability_subset";
    free(device_extensions);
    float priority = 1.0f;
    VkDeviceQueueCreateInfo queue_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex = r->family,
        .queueCount = 1,
        .pQueuePriorities = &priority
    };
    VkDeviceCreateInfo device_info = {
        .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,
        .queueCreateInfoCount = 1,
        .pQueueCreateInfos = &queue_info,
        .enabledExtensionCount = enabled,
        .ppEnabledExtensionNames = device_names
    };
    VULKAN(vkCreateDevice(r->physical, &device_info, NULL, &r->device));
    vkGetDeviceQueue(r->device, r->family, 0, &r->queue);
}

static void create_image(Renderer *r) {
    VkImageCreateInfo image_info = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
        .imageType = VK_IMAGE_TYPE_2D,
        .format = VK_FORMAT_R8G8B8A8_UNORM,
        .extent = { image_width, image_height, 1 },
        .mipLevels = 1,
        .arrayLayers = 1,
        .samples = VK_SAMPLE_COUNT_1_BIT,
        .tiling = VK_IMAGE_TILING_OPTIMAL,
        .usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
        .sharingMode = VK_SHARING_MODE_EXCLUSIVE,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED
    };
    VULKAN(vkCreateImage(r->device, &image_info, NULL, &r->image));
    VkMemoryRequirements requirements;
    vkGetImageMemoryRequirements(r->device, r->image, &requirements);
    r->image_memory = allocate(r, requirements, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    VULKAN(vkBindImageMemory(r->device, r->image, r->image_memory, 0));
    VkImageViewCreateInfo view_info = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,
        .image = r->image,
        .viewType = VK_IMAGE_VIEW_TYPE_2D,
        .format = VK_FORMAT_R8G8B8A8_UNORM,
        .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }
    };
    VULKAN(vkCreateImageView(r->device, &view_info, NULL, &r->view));
    VkAttachmentDescription attachment = {
        .format = VK_FORMAT_R8G8B8A8_UNORM,
        .samples = VK_SAMPLE_COUNT_1_BIT,
        .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
        .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
        .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
        .stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE,
        .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
        .finalLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL
    };
    VkAttachmentReference reference = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
    VkSubpassDescription subpass = {
        .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
        .colorAttachmentCount = 1,
        .pColorAttachments = &reference
    };
    VkRenderPassCreateInfo pass_info = {
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO,
        .attachmentCount = 1,
        .pAttachments = &attachment,
        .subpassCount = 1,
        .pSubpasses = &subpass
    };
    VULKAN(vkCreateRenderPass(r->device, &pass_info, NULL, &r->render_pass));
    VkFramebufferCreateInfo framebuffer_info = {
        .sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO,
        .renderPass = r->render_pass,
        .attachmentCount = 1,
        .pAttachments = &r->view,
        .width = image_width,
        .height = image_height,
        .layers = 1
    };
    VULKAN(vkCreateFramebuffer(r->device, &framebuffer_info, NULL, &r->framebuffer));
}

static void create_pipelines(Renderer *r, const char *shader_dir) {
    VkDescriptorSetLayoutBinding binding = {
        .binding = 0,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount = 1,
        .stageFlags = VK_SHADER_STAGE_COMPUTE_BIT | VK_SHADER_STAGE_FRAGMENT_BIT
    };
    VkDescriptorSetLayoutCreateInfo set_info = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount = 1,
        .pBindings = &binding
    };
    VULKAN(vkCreateDescriptorSetLayout(r->device, &set_info, NULL, &r->set_layout));
    VkPipelineLayoutCreateInfo layout_info = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount = 1,
        .pSetLayouts = &r->set_layout
    };
    VULKAN(vkCreatePipelineLayout(r->device, &layout_info, NULL, &r->pipeline_layout));
    VkDescriptorPoolSize pool_size = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 };
    VkDescriptorPoolCreateInfo pool_info = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets = 1,
        .poolSizeCount = 1,
        .pPoolSizes = &pool_size
    };
    VULKAN(vkCreateDescriptorPool(r->device, &pool_info, NULL, &r->descriptor_pool));
    VkDescriptorSetAllocateInfo set_allocate = {
        .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool = r->descriptor_pool,
        .descriptorSetCount = 1,
        .pSetLayouts = &r->set_layout
    };
    VULKAN(vkAllocateDescriptorSets(r->device, &set_allocate, &r->descriptor_set));
    VkDescriptorBufferInfo buffer_info = { r->storage, 0, r->storage_size };
    VkWriteDescriptorSet write = {
        .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
        .dstSet = r->descriptor_set,
        .dstBinding = 0,
        .descriptorCount = 1,
        .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .pBufferInfo = &buffer_info
    };
    vkUpdateDescriptorSets(r->device, 1, &write, 0, NULL);

    char path[4096];
    snprintf(path, sizeof(path), "%s/launcher.vert.spv", shader_dir);
    VkShaderModule vertex = load_shader(r, path);
    snprintf(path, sizeof(path), "%s/launcher.frag.spv", shader_dir);
    VkShaderModule fragment = load_shader(r, path);
    snprintf(path, sizeof(path), "%s/launcher.comp.spv", shader_dir);
    VkShaderModule compute = load_shader(r, path);
    VkPipelineShaderStageCreateInfo stages[2] = {
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_VERTEX_BIT, .module = vertex, .pName = "main" },
        { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
          .stage = VK_SHADER_STAGE_FRAGMENT_BIT, .module = fragment, .pName = "main" }
    };
    VkPipelineVertexInputStateCreateInfo vertex_input = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO
    };
    VkPipelineInputAssemblyStateCreateInfo assembly = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
        .topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST
    };
    VkViewport viewport = { 0, 0, image_width, image_height, 0, 1 };
    VkRect2D scissor = { { 0, 0 }, { image_width, image_height } };
    VkPipelineViewportStateCreateInfo viewport_state = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO,
        .viewportCount = 1,
        .pViewports = &viewport,
        .scissorCount = 1,
        .pScissors = &scissor
    };
    VkPipelineRasterizationStateCreateInfo raster = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
        .polygonMode = VK_POLYGON_MODE_FILL,
        .cullMode = VK_CULL_MODE_NONE,
        .frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE,
        .lineWidth = 1
    };
    VkPipelineMultisampleStateCreateInfo multisample = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
        .rasterizationSamples = VK_SAMPLE_COUNT_1_BIT
    };
    VkPipelineColorBlendAttachmentState blend_attachment = { .colorWriteMask = 15 };
    VkPipelineColorBlendStateCreateInfo blend = {
        .sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO,
        .attachmentCount = 1,
        .pAttachments = &blend_attachment
    };
    VkGraphicsPipelineCreateInfo graphics_info = {
        .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
        .stageCount = 2,
        .pStages = stages,
        .pVertexInputState = &vertex_input,
        .pInputAssemblyState = &assembly,
        .pViewportState = &viewport_state,
        .pRasterizationState = &raster,
        .pMultisampleState = &multisample,
        .pColorBlendState = &blend,
        .layout = r->pipeline_layout,
        .renderPass = r->render_pass
    };
    VULKAN(vkCreateGraphicsPipelines(r->device, VK_NULL_HANDLE, 1, &graphics_info, NULL, &r->graphics));
    VkComputePipelineCreateInfo compute_info = {
        .sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage = { .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
                   .stage = VK_SHADER_STAGE_COMPUTE_BIT, .module = compute, .pName = "main" },
        .layout = r->pipeline_layout
    };
    VULKAN(vkCreateComputePipelines(r->device, VK_NULL_HANDLE, 1, &compute_info, NULL, &r->compute));
    vkDestroyShaderModule(r->device, vertex, NULL);
    vkDestroyShaderModule(r->device, fragment, NULL);
    vkDestroyShaderModule(r->device, compute, NULL);
}

static void create_command(Renderer *r) {
    VkCommandPoolCreateInfo pool_info = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,
        .queueFamilyIndex = r->family
    };
    VULKAN(vkCreateCommandPool(r->device, &pool_info, NULL, &r->command_pool));
    VkCommandBufferAllocateInfo allocate = {
        .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool = r->command_pool,
        .level = VK_COMMAND_BUFFER_LEVEL_PRIMARY,
        .commandBufferCount = 1
    };
    VULKAN(vkAllocateCommandBuffers(r->device, &allocate, &r->command));
}

static void render_frame(Renderer *r) {
    VULKAN(vkResetCommandBuffer(r->command, 0));
    VkCommandBufferBeginInfo begin = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    VULKAN(vkBeginCommandBuffer(r->command, &begin));

    VkMemoryBarrier barrier = {
        .sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_HOST_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT
    };
    vkCmdPipelineBarrier(r->command, VK_PIPELINE_STAGE_HOST_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         0, 1, &barrier, 0, NULL, 0, NULL);
    vkCmdBindDescriptorSets(r->command, VK_PIPELINE_BIND_POINT_COMPUTE,
                            r->pipeline_layout, 0, 1, &r->descriptor_set, 0, NULL);
    vkCmdBindPipeline(r->command, VK_PIPELINE_BIND_POINT_COMPUTE, r->compute);
    vkCmdDispatch(r->command, 1, 1, 1);
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(r->command, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, 0, 1, &barrier, 0, NULL, 0, NULL);

    VkClearValue clear = { .color = {{ 0, 0, 0, 1 }} };
    VkRenderPassBeginInfo pass = {
        .sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO,
        .renderPass = r->render_pass,
        .framebuffer = r->framebuffer,
        .renderArea = { { 0, 0 }, { image_width, image_height } },
        .clearValueCount = 1,
        .pClearValues = &clear
    };
    vkCmdBeginRenderPass(r->command, &pass, VK_SUBPASS_CONTENTS_INLINE);
    vkCmdBindDescriptorSets(r->command, VK_PIPELINE_BIND_POINT_GRAPHICS,
                            r->pipeline_layout, 0, 1, &r->descriptor_set, 0, NULL);
    vkCmdBindPipeline(r->command, VK_PIPELINE_BIND_POINT_GRAPHICS, r->graphics);
    vkCmdDraw(r->command, 3, 1, 0, 0);
    vkCmdEndRenderPass(r->command);

    VkImageMemoryBarrier image_barrier = {
        .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT,
        .dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT,
        .oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
        .newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
        .srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED,
        .image = r->image,
        .subresourceRange = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 }
    };
    vkCmdPipelineBarrier(r->command, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
                         VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, NULL, 0, NULL, 1, &image_barrier);
    VkBufferImageCopy copy = {
        .imageSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 },
        .imageExtent = { image_width, image_height, 1 }
    };
    vkCmdCopyImageToBuffer(r->command, r->image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                           r->readback, 1, &copy);
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(r->command, VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &barrier, 0, NULL, 0, NULL);
    VULKAN(vkEndCommandBuffer(r->command));
    VkSubmitInfo submit = {
        .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
        .commandBufferCount = 1,
        .pCommandBuffers = &r->command
    };
    VULKAN(vkQueueSubmit(r->queue, 1, &submit, VK_NULL_HANDLE));
    VULKAN(vkQueueWaitIdle(r->queue));
}

static void update_input(Renderer *r, GLFWwindow *window, double *last_x, double *last_y) {
    uint32_t buttons = 0;
    if (glfwGetKey(window, GLFW_KEY_UP) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS)
        buttons |= 8192u;
    if (glfwGetKey(window, GLFW_KEY_DOWN) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS)
        buttons |= 32768u;
    if (glfwGetKey(window, GLFW_KEY_LEFT) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS)
        buttons |= 4096u;
    if (glfwGetKey(window, GLFW_KEY_RIGHT) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS)
        buttons |= 16384u;
    if (glfwGetKey(window, GLFW_KEY_ENTER) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_SPACE) == GLFW_PRESS ||
        glfwGetKey(window, GLFW_KEY_Z) == GLFW_PRESS)
        buttons |= 1u;
    if (glfwGetKey(window, GLFW_KEY_BACKSPACE) == GLFW_PRESS || glfwGetKey(window, GLFW_KEY_X) == GLFW_PRESS)
        buttons |= 2u;
    if (glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS)
        buttons |= 512u;
    put_word(r->state, 8, buttons);
    put_word(r->state, 32, 1u);

    int width, height;
    glfwGetWindowSize(window, &width, &height);
    double x, y;
    glfwGetCursorPos(window, &x, &y);
    float screen_x = (float)(x * image_width / width);
    float screen_y = (float)(y * image_height / height);
    if (screen_x < 24) screen_x = 24;
    if (screen_x > 1896) screen_x = 1896;
    if (screen_y < 24) screen_y = 24;
    if (screen_y > 1056) screen_y = 1056;
    int moved = x != *last_x || y != *last_y;
    put_word(r->state, 784, 1u);
    put_word(r->state, 788, 1u);
    put_float(r->state, 816, screen_x - (moved ? 18.0f : 0.0f));
    put_float(r->state, 820, screen_y);
    put_word(r->state, 24, moved ? 32767u : 0u);
    put_word(r->state, 28, 0u);
    *last_x = x;
    *last_y = y;
}

static void show_frame(GLFWwindow *window, GLuint texture, const uint8_t *pixels) {
    int width, height;
    glfwGetFramebufferSize(window, &width, &height);
    glViewport(0, 0, width, height);
    glMatrixMode(GL_PROJECTION);
    glLoadIdentity();
    glOrtho(0, 1, 1, 0, -1, 1);
    glMatrixMode(GL_MODELVIEW);
    glLoadIdentity();
    glClear(GL_COLOR_BUFFER_BIT);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, image_width, image_height,
                    GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    glEnable(GL_TEXTURE_2D);
    glBegin(GL_QUADS);
    glTexCoord2f(0, 0); glVertex2f(0, 0);
    glTexCoord2f(1, 0); glVertex2f(1, 0);
    glTexCoord2f(1, 1); glVertex2f(1, 1);
    glTexCoord2f(0, 1); glVertex2f(0, 1);
    glEnd();
    glfwSwapBuffers(window);
}

static void cleanup(Renderer *r) {
    vkDeviceWaitIdle(r->device);
    vkDestroyCommandPool(r->device, r->command_pool, NULL);
    vkDestroyPipeline(r->device, r->compute, NULL);
    vkDestroyPipeline(r->device, r->graphics, NULL);
    vkDestroyDescriptorPool(r->device, r->descriptor_pool, NULL);
    vkDestroyPipelineLayout(r->device, r->pipeline_layout, NULL);
    vkDestroyDescriptorSetLayout(r->device, r->set_layout, NULL);
    vkDestroyFramebuffer(r->device, r->framebuffer, NULL);
    vkDestroyRenderPass(r->device, r->render_pass, NULL);
    vkDestroyImageView(r->device, r->view, NULL);
    vkDestroyImage(r->device, r->image, NULL);
    vkFreeMemory(r->device, r->image_memory, NULL);
    vkUnmapMemory(r->device, r->storage_memory);
    vkDestroyBuffer(r->device, r->storage, NULL);
    vkFreeMemory(r->device, r->storage_memory, NULL);
    vkUnmapMemory(r->device, r->readback_memory);
    vkDestroyBuffer(r->device, r->readback, NULL);
    vkFreeMemory(r->device, r->readback_memory, NULL);
    vkDestroyDevice(r->device, NULL);
    vkDestroyInstance(r->instance, NULL);
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s STATE.BIN ATLAS.BIN SHADER_DIRECTORY\n", argv[0]);
        return 2;
    }
    size_t state_length, atlas_length;
    uint8_t *initial_state = read_file(argv[1], &state_length);
    uint8_t *atlas = read_file(argv[2], &atlas_length);
    REQUIRE(state_length == state_size && atlas_length >= 6 * 1024 * 1024);
    REQUIRE(glfwInit());
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 2);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 1);
    glfwWindowHint(GLFW_RESIZABLE, GLFW_FALSE);
    GLFWwindow *window = glfwCreateWindow(1280, 720, "MintBrew desktop preview", NULL, NULL);
    REQUIRE(window);
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);

    Renderer renderer = { 0 };
    create_device(&renderer);
    renderer.storage_size = state_size + atlas_length;
    renderer.storage = create_buffer(&renderer, renderer.storage_size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
                                     &renderer.storage_memory, &renderer.state);
    renderer.readback = create_buffer(&renderer, image_width * image_height * 4,
                                      VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                                      &renderer.readback_memory, &renderer.pixels);
    memcpy(renderer.state, initial_state, state_size);
    memcpy(renderer.state + state_size, atlas, atlas_length);
    put_word(renderer.state, 32, 1u);
    if (word(renderer.state, 1020) == 0) put_word(renderer.state, 1020, word(renderer.state, 112));
    free(initial_state);
    free(atlas);
    create_image(&renderer);
    create_pipelines(&renderer, argv[3]);
    create_command(&renderer);

    GLuint texture;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, image_width, image_height, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    fprintf(stderr, "mintbrew desktop: arrows/WASD navigate; enter/space/Z select; X/backspace goes back; mouse hovers/clicks; escape closes\n");
    double last_x, last_y;
    glfwGetCursorPos(window, &last_x, &last_y);
    uint32_t last_selected = UINT32_MAX;
    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS) break;
        update_input(&renderer, window, &last_x, &last_y);
        render_frame(&renderer);
        uint32_t selected = word(renderer.state, 80);
        if (selected != last_selected) {
            fprintf(stderr, "mintbrew desktop: selected app %u of %u\n",
                    selected + 1, word(renderer.state, 112));
            last_selected = selected;
        }
        if (word(renderer.state, 1012) != 0) {
            fprintf(stderr, "mintbrew desktop: app %u selected; launcher preview stays open\n",
                    word(renderer.state, 1012));
            put_word(renderer.state, 1012, 0);
            put_float(renderer.state, 964, 0);
            put_float(renderer.state, 960, 0);
        }
        show_frame(window, texture, renderer.pixels);
    }
    glDeleteTextures(1, &texture);
    cleanup(&renderer);
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
